import base64
from contextlib import redirect_stdout
from email.message import Message
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import client as c
import qq
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class Response(io.BytesIO):
    def __init__(self, code, headers, body):
        super().__init__(body)
        self.status = code
        self.headers = headers


class FixtureServer:
    """Offline in-memory server. No listening sockets or live service calls."""
    def __init__(self, config, client_key, server_key):
        self.config, self.client_key, self.server_key = config, client_key, server_key
        self.calls = []
        self.code = 200
        self.body = None
        self.mutate = lambda code, headers, body: (code, headers, body)
        self.fail = False

    def open(self, request, timeout):
        self.calls.append(request)
        if self.fail:
            raise urllib.error.URLError('secret-proxy-token-that-must-not-be-printed')
        endpoint = request.full_url[len(self.config['server_url']):]
        protocol = 'status' if endpoint == '/qq/status' else 'chat'
        body = request.data or b''
        if request.method == 'POST':
            assert body == c.compact_json_bytes(body)
            assert request.get_header('Content-length') == str(len(body))
        nonce = request.get_header('X-dot-nonce')
        message = c.canonical([f'napcat-{protocol}-request-v1', self.config['server_url'],
                               self.config['client_key_id'], request.method, endpoint,
                               request.get_header('X-dot-timestamp'), nonce, c.digest(body)])
        self.client_key.public_key().verify(c.signature_bytes(request.get_header('X-dot-signature')), message)
        result = self.body if self.body is not None else (b'{"online":true}' if protocol == 'status' else b'{"state":"sent"}')
        stamp = str(int(time.time() * 1000))
        headers = Message()
        headers['Content-Length'] = str(len(result))
        headers['X-Dot-Server-Key-Id'] = self.config['server_key_id']
        headers['X-Dot-Request-Hash'] = c.digest(message)
        headers['X-Dot-Response-Timestamp'] = stamp
        answer = c.canonical([f'napcat-{protocol}-response-v1', self.config['server_url'],
                              self.config['server_key_id'], c.digest(message), stamp, nonce,
                              str(self.code), c.digest(result)])
        headers['X-Dot-Response-Signature'] = c.b64(self.server_key.sign(answer))
        code, headers, result = self.mutate(self.code, headers, result)
        return Response(code, headers, result)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        # Ephemeral keys exist only in memory; never provisioned or registered.
        self.private = Ed25519PrivateKey.generate()
        self.server = Ed25519PrivateKey.generate()
        self.config = qq.load_template()
        self.config.update(server_url='https://qq.example.invalid', client_key_id='test-client',
                           server_key_id='test-server', expected_qq_id='9000000001',
                           account_binding_confirmed=True, _directory=self.root,
                           server_public_key_raw_base64=base64.b64encode(self.server.public_key().public_bytes(
                               serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode())
        self.opener = FixtureServer(self.config, self.private, self.server)
        self.client = c.SignedClient(self.config, key=self.private, opener=self.opener)

    def tearDown(self):
        self.directory.cleanup()

    def send_body(self, identifier=None):
        return json.dumps({'request_id': identifier or str(uuid.uuid4()),
                           'conversation': {'type': 'private', 'id': '9000000002'},
                           'messages': [{'type': 'text', 'text': 'offline fixture'}]}).encode()

    def test_status_signature_and_no_false_qq_identity(self):
        answer = self.client.call()
        self.assertTrue(answer['ok'])
        self.assertTrue(answer['body']['online'])
        self.assertTrue(answer['response_signature_verified'])
        self.assertFalse(answer['qq_identity_verified'])
        self.assertFalse((self.root / 'state').exists())

    def test_unicode_compact_json_and_opaque_cursor(self):
        payload = {'conversation': {'type': 'group', 'id': '9000000003'}, 'cursor': '完整+/=opaque==', 'text': '你好🌻'}
        self.client.call('read_history', json.dumps(payload, ensure_ascii=False, indent=2).encode())
        self.assertEqual(json.loads(self.opener.calls[-1].data), payload)
        self.assertNotIn(b'\n', self.opener.calls[-1].data)

    def test_body_tampering_refused_without_retry(self):
        self.opener.mutate = lambda code, headers, body: (code, headers, body.replace(b'true', b'null'))
        with self.assertRaisesRegex(c.ClientError, 'invalid_response_signature'):
            self.client.call()
        self.assertEqual(len(self.opener.calls), 1)

    def test_request_binding_refused(self):
        def change(code, headers, body):
            headers.replace_header('X-Dot-Request-Hash', '0' * 64)
            return code, headers, body
        self.opener.mutate = change
        with self.assertRaisesRegex(c.ClientError, 'binding_mismatch'):
            self.client.call()

    def test_wrong_server_key_refused(self):
        def change(code, headers, body):
            headers.replace_header('X-Dot-Server-Key-Id', 'different-server')
            return code, headers, body
        self.opener.mutate = change
        with self.assertRaisesRegex(c.ClientError, 'unexpected_server_key'):
            self.client.call()

    def test_stale_response_refused(self):
        def change(code, headers, body):
            headers.replace_header('X-Dot-Response-Timestamp', str(int(time.time() * 1000) - 60000))
            return code, headers, body
        self.opener.mutate = change
        with self.assertRaisesRegex(c.ClientError, 'stale_response'):
            self.client.call()

    def test_nonce_binding(self):
        original = self.opener.mutate
        def change(code, headers, body):
            headers.replace_header('X-Dot-Response-Signature', c.b64(self.server.sign(b'wrong nonce')))
            return original(code, headers, body)
        self.opener.mutate = change
        with self.assertRaisesRegex(c.ClientError, 'invalid_response_signature'):
            self.client.call()

    def test_duplicate_headers_refused(self):
        def change(code, headers, body):
            headers['X-Dot-Server-Key-Id'] = 'duplicate'
            return code, headers, body
        self.opener.mutate = change
        with self.assertRaisesRegex(c.ClientError, 'duplicate_response_header'):
            self.client.call()

    def test_redirect_refused(self):
        self.opener.code = 302
        with self.assertRaisesRegex(c.ClientError, 'redirect_refused'):
            self.client.call()
        self.assertIsNone(c.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_compressed_response_refused(self):
        def change(code, headers, body):
            headers['Content-Encoding'] = 'gzip'
            return code, headers, body
        self.opener.mutate = change
        with self.assertRaisesRegex(c.ClientError, 'encoded_response'):
            self.client.call()

    def test_oversize_response_refused(self):
        self.opener.body = b'x' * 4097
        with self.assertRaisesRegex(c.ClientError, 'oversize_response'):
            self.client.call()

    def test_status_schema_strict(self):
        self.opener.body = b'{"online":true,"self_id":"pretend"}'
        with self.assertRaisesRegex(c.ClientError, 'unexpected_status_schema'):
            self.client.call()

    def test_verified_http_failure_is_failure(self):
        self.opener.code, self.opener.body = 503, b'{"error":"unavailable"}'
        answer = self.client.call()
        self.assertFalse(answer['ok'])
        self.assertTrue(answer['response_signature_verified'])

    def test_send_once_and_restart_blocks_duplicate(self):
        body = self.send_body()
        self.assertEqual(self.client.call('send_message', body)['mutation_state'], 'sent')
        new_client = c.SignedClient(self.config, key=self.private, opener=self.opener)
        with self.assertRaisesRegex(c.ClientError, 'uuid_already_attempted'):
            new_client.call('send_message', body)
        self.assertEqual(len(self.opener.calls), 1)

    def test_ambiguous_send_never_retried_and_ledger_has_no_body(self):
        self.opener.fail = True
        body = self.send_body()
        answer = self.client.call('send_message', body)
        self.assertEqual(answer['mutation_state'], 'unknown')
        self.assertFalse(answer['automatic_retry'])
        self.assertEqual(answer['lookup_tool'], 'get_send_result')
        with self.assertRaisesRegex(c.ClientError, 'uuid_already_attempted'):
            self.client.call('send_message', body)
        ledger = (self.root / 'state' / 'attempts.sqlite3').read_bytes()
        self.assertNotIn(b'offline fixture', ledger)
        self.assertNotIn(b'secret-proxy-token', json.dumps(answer).encode())
        self.assertEqual(len(self.opener.calls), 1)

    def test_cross_send_route_and_changed_body_blocked(self):
        body = self.send_body()
        self.client.call('send_message', body)
        with self.assertRaisesRegex(c.ClientError, 'uuid_already_attempted'):
            self.client.call('send_audio', body)
        value = json.loads(body); value['messages'][0]['text'] = 'changed'
        with self.assertRaisesRegex(c.ClientError, 'uuid_already_attempted'):
            self.client.call('send_message', json.dumps(value).encode())

    def test_invalid_or_missing_uuid_refused_before_network(self):
        for raw in [b'{}', b'{"request_id":"bad"}', b'{"request_id":"00000000-0000-1000-8000-000000000000"}']:
            with self.assertRaisesRegex(c.ClientError, 'canonical_uuid4'):
                self.client.call('send_message', raw)
        self.assertFalse(self.opener.calls)

    def test_executors_and_unknown_tools_are_unavailable(self):
        for tool in ['agent/submit', '/agent/host/run', 'shell', 'get_login_info', '../send_message']:
            with self.assertRaisesRegex(c.ClientError, 'only_reviewed_qq_tools'):
                self.client.call(tool)
        self.assertFalse(self.opener.calls)

    def test_unconfirmed_account_blocked(self):
        self.config['account_binding_confirmed'] = False
        with self.assertRaisesRegex(c.ClientError, 'confirm_dedicated_qq_binding'):
            c.SignedClient(self.config, key=self.private, opener=self.opener)
        self.assertFalse(self.opener.calls)

    def test_invalid_origin_refused(self):
        for origin in ['http://qq.example.invalid', 'https://qq.example.invalid/',
                       'https://qq.example.invalid/bot2', 'https://name:secret@qq.example.invalid',
                       'https://qq.example.invalid?bad=1', 'https://qq.example.invalid#frag']:
            self.config['server_url'] = origin
            with self.assertRaises(c.ClientError):
                c.validate_origin(self.config)

    def test_proxy_required_without_bypass_fallback(self):
        with patch('urllib.request.getproxies', return_value={}), patch('urllib.request.build_opener') as build:
            with self.assertRaisesRegex(c.ClientError, 'no_direct_fallback'):
                c.make_opener(self.config)
            build.assert_not_called()
        with patch('urllib.request.getproxies', return_value={'https': 'http://proxy.example.invalid'}), patch('urllib.request.proxy_bypass', return_value=True):
            with self.assertRaisesRegex(c.ClientError, 'no_direct_fallback'):
                c.make_opener(self.config)

    def test_tls_verification_stays_enabled(self):
        self.config['require_https_proxy'] = False
        with patch('urllib.request.getproxies', return_value={}), patch('urllib.request.build_opener'), patch('urllib.request.HTTPSHandler', wraps=c.urllib.request.HTTPSHandler) as handler:
            c.make_opener(self.config)
            context = handler.call_args.kwargs['context']
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_duplicate_json_and_nonfinite_json_rejected(self):
        for body in [b'{"a":1,"a":2}', b'{"x":NaN}', b'[]']:
            with self.assertRaises(c.ClientError):
                c.compact_json_bytes(body)

    def test_collect_uses_explicit_local_operation_id(self):
        with self.assertRaisesRegex(c.ClientError, 'canonical_uuid4'):
            self.client.call('collect_favorite', b'{}')
        self.client.call('collect_favorite', b'{}', operation_id=str(uuid.uuid4()))
        self.assertEqual(self.opener.calls[-1].data, b'{}')

    def test_offline_doctor_creates_nothing(self):
        with patch.object(c, 'load_private_key', return_value=self.private):
            result = c.doctor(self.config)
        self.assertTrue(result['ok'])
        self.assertFalse(result['network_requested'])
        self.assertFalse(result['qq_identity_verified'])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_template_and_setup_are_safe_and_repeatable(self):
        nested = self.root / 'client'
        nested.mkdir()
        for name in ['qq.py', 'client.py']:
            shutil.copy(c.ROOT / name, nested / name)
        shutil.copy(c.ROOT.parent / 'config.example.json', self.root / 'config.example.json')
        for _ in range(2):
            result = subprocess.run([sys.executable, str(nested / 'qq.py'), 'setup', '--skip-install'],
                                    check=True, capture_output=True, text=True)
            self.assertFalse(json.loads(result.stdout)['credentials_created'])
        template = json.loads((nested / 'config.json').read_text())
        self.assertFalse(template['account_binding_confirmed'])
        self.assertEqual(template['server_url'], '')
        self.assertEqual(template['client_key_id'], 'qq-client')
        self.assertFalse((self.root / 'identity').exists())
        self.assertFalse((self.root / 'state').exists())
        process = subprocess.run([sys.executable, str(nested / 'qq.py'), 'doctor'], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertFalse(json.loads(process.stdout)['network_requested'])


    def test_unified_root_template_is_supported(self):
        nested = self.root / 'client'
        nested.mkdir()
        shutil.copy(c.ROOT / 'qq.py', nested / 'qq.py')
        shutil.copy(c.ROOT.parent / 'config.example.json', self.root / 'config.example.json')
        result = subprocess.run([sys.executable, str(nested / 'qq.py'), 'setup', '--skip-install'],
                                check=True, capture_output=True, text=True)
        self.assertTrue(json.loads(result.stdout)['config_created'])
        self.assertEqual(json.loads((nested / 'config.json').read_text()), qq.load_template())
        self.assertFalse((nested / 'config.example.json').exists())

    def test_missing_config_redacts_errors(self):
        output = io.StringIO()
        with redirect_stdout(output):
            rc = c.main(['--config', '/missing-private-config.json', 'doctor'])
        self.assertEqual(rc, 1)
        self.assertNotIn('/missing-private-config', output.getvalue())


if __name__ == '__main__':
    unittest.main()
