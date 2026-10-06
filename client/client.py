"""Portable QQ gateway client, adapted from the existing signed Python client.

Canonical signing bytes match check.py/tool_call.py/persistent_client.py.
No credentials are generated. No automatic retries or cursor updates.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import uuid
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
READ_TOOLS = frozenset({'poll_events', 'read_history', 'search_history', 'get_message',
                        'view_media', 'get_chat_info', 'get_send_result', 'list_favorites',
                        'get_favorite', 'get_favorite_send_result', 'get_qq_favorite_result',
                        'get_message_action_result', 'get_reaction_result', 'read_reactions', 'poll_notices'})
# (wire ID field, reconciliation tool). No /agent or unrestricted endpoint escape.
WRITE_TOOLS = {
    'send_message': ('request_id', 'get_send_result'),
    'send_audio': ('request_id', 'get_send_result'),
    'send_favorite': ('request_id', 'get_favorite_send_result'),
    'add_qq_favorite': ('request_id', 'get_qq_favorite_result'),
    'react_message': ('action_id', 'get_reaction_result'),
    'recall_test_message': ('action_id', 'get_message_action_result'),
    'declare_test_send': ('request_id', 'get_send_result'),
    'register_test_send': ('request_id', 'get_send_result'),
    'collect_favorite': (None, 'list_favorites'),
    'verify_qq_favorite': ('request_id', 'get_qq_favorite_result'),
}
ALL_TOOLS = READ_TOOLS | WRITE_TOOLS.keys()
MAX_BODY = 16 * 1024 * 1024
FIELDS = frozenset({'schema_version', 'server_url', 'client_key_id', 'private_key_file',
                    'server_key_id', 'server_public_key_raw_base64', 'expected_qq_id',
                    'account_binding_confirmed', 'require_https_proxy', 'timeout_seconds', 'state_directory'})


class ClientError(Exception):
    """Messages are deliberately static: never include credentials or payloads."""


def canonical(fields):
    return ('\n'.join(fields) + '\n').encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def signature_bytes(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{86}', value):
        raise ClientError('invalid_response_signature_encoding')
    return base64.b64decode(value + '==', altchars=b'-_', validate=True)


def unique_object(pairs):
    answer = {}
    for key, value in pairs:
        if key in answer:
            raise ClientError('duplicate_json_key')
        answer[key] = value
    return answer


def parse_json(raw):
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ClientError('nonfinite_json')))


def compact_json_bytes(raw):
    value = parse_json(raw)
    if not isinstance(value, dict):
        raise ClientError('request_must_be_json_object')
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(data) > MAX_BODY:
        raise ClientError('request_too_large')
    return data


def load_config(path):
    path = Path(path).resolve()
    data = parse_json(path.read_bytes())
    if not isinstance(data, dict) or set(data) != FIELDS or type(data['schema_version']) is not int or data['schema_version'] != 1:
        raise ClientError('invalid_config_schema')
    for name in FIELDS - {'schema_version', 'account_binding_confirmed', 'require_https_proxy', 'timeout_seconds'}:
        if not isinstance(data[name], str) or '\n' in data[name] or '\r' in data[name]:
            raise ClientError('invalid_config_string')
    if type(data['account_binding_confirmed']) is not bool or type(data['require_https_proxy']) is not bool:
        raise ClientError('invalid_config_boolean')
    if type(data['timeout_seconds']) is not int or not 1 <= data['timeout_seconds'] <= 60:
        raise ClientError('invalid_timeout')
    for field in ('private_key_file', 'state_directory'):
        relative = Path(data[field])
        if relative.is_absolute() or not relative.parts or '..' in relative.parts:
            raise ClientError('local_paths_must_be_nonempty_and_relative')
    data['_directory'] = path.parent
    return data


def validate_origin(config):
    url = config['server_url']
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.path or parts.query or parts.fragment or parts.netloc != parts.netloc.lower()
            or any(c.isspace() for c in url)):
        raise ClientError('server_url_must_be_exact_https_origin_without_trailing_slash')
    try:
        parts.port
    except ValueError as exc:
        raise ClientError('invalid_server_port') from exc
    return parts


def validate_identity_config(config):
    validate_origin(config)
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', config['client_key_id']):
        raise ClientError('client_key_id_required')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', config['server_key_id']):
        raise ClientError('server_key_id_required')
    if not re.fullmatch(r'[1-9][0-9]{0,19}', config['expected_qq_id']):
        raise ClientError('expected_qq_id_required')
    if not config['account_binding_confirmed']:
        raise ClientError('server_operator_must_confirm_dedicated_qq_binding_first')
    try:
        raw = base64.b64decode(config['server_public_key_raw_base64'], validate=True)
    except ValueError as exc:
        raise ClientError('invalid_server_public_key') from exc
    if len(raw) != 32:
        raise ClientError('invalid_server_public_key')
    return raw


def crypto():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    except ImportError as exc:
        raise ClientError('dependency_missing_run_python3_qq_py_setup') from exc
    return serialization, Ed25519PrivateKey, Ed25519PublicKey


def load_private_key(config):
    serialization, private_type, _ = crypto()
    key_path = config['_directory'] / config['private_key_file']
    # Never follow a key symlink outside the configuration directory.
    directory = config['_directory'].resolve()
    if not key_path.resolve().is_relative_to(directory) or key_path.is_symlink():
        raise ClientError('unsafe_private_key_path')
    info = key_path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ClientError('private_key_must_be_regular_file')
    if os.name == 'posix' and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        raise ClientError('private_key_requires_owner_only_permissions_0600')
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    if not isinstance(key, private_type):
        raise ClientError('private_key_must_be_ed25519')
    return key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def make_opener(config):
    origin = validate_origin(config)
    proxies = urllib.request.getproxies()
    if config['require_https_proxy'] and (not proxies.get('https') or urllib.request.proxy_bypass(origin.hostname)):
        raise ClientError('platform_https_proxy_required_no_direct_fallback')
    context = ssl.create_default_context()
    if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
        raise ClientError('tls_verification_required')
    # One platform-selected route. Proxy rejection is final, not a trigger to
    # swap proxies, use IP tricks, change NO_PROXY or retry a direct connection.
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies),
                                      urllib.request.HTTPSHandler(context=context), NoRedirect())


def fetch(opener, request, timeout, limit):
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        for name in ('Content-Length', 'Content-Encoding', 'X-Dot-Server-Key-Id',
                     'X-Dot-Request-Hash', 'X-Dot-Response-Timestamp', 'X-Dot-Response-Signature'):
            if hasattr(response.headers, 'get_all') and len(response.headers.get_all(name, [])) > 1:
                raise ClientError('duplicate_response_header')
        if 300 <= response.status < 400:
            raise ClientError('redirect_refused')
        if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            raise ClientError('encoded_response_refused')
        length = response.headers.get('Content-Length')
        if length is not None:
            if not re.fullmatch(r'[0-9]+', length) or int(length) > limit:
                raise ClientError('invalid_or_oversize_response_length')
        chunks = bytearray()
        deadline = time.monotonic() + timeout
        read_chunk = getattr(response, 'read1', response.read)
        while True:
            if time.monotonic() >= deadline:
                raise ClientError('response_deadline_exceeded')
            part = read_chunk(min(65536, limit + 1 - len(chunks)))
            if not part:
                break
            chunks.extend(part)
            if len(chunks) > limit:
                raise ClientError('response_too_large')
        body = bytes(chunks)
        if length is not None and len(body) != int(length):
            raise ClientError('incomplete_response')
        return response.status, response.headers, body


def probe(config, opener=None):
    validate_origin(config)
    request = urllib.request.Request(config['server_url'] + '/qq/status', method='GET',
                                     headers={'Accept-Encoding': 'identity'})
    status, headers, body = fetch(opener or make_opener(config), request, config['timeout_seconds'], 4096)
    return {'ok': True, 'http': status, 'tls_verified': True,
            'response_signature_verified': False, 'qq_identity_verified': False,
            'application_health_verified': False,
            'detail': 'Unsigned existing /qq/status probe. An auth rejection is expected; this proves only TLS/HTTP reachability.'}


class AttemptLedger:
    """Durable IDs/digests only. Reserves before I/O; no chat bodies or secrets."""
    def __init__(self, config):
        directory = config['_directory'] / config['state_directory']
        if not directory.resolve().is_relative_to(config['_directory'].resolve()) or directory.is_symlink():
            raise ClientError('unsafe_state_directory')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.stat()
        if os.name == 'posix' and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise ClientError('state_directory_requires_owner_only_permissions_0700')
        path = directory / 'attempts.sqlite3'
        if path.is_symlink():
            raise ClientError('unsafe_ledger_file')
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or (os.name == 'posix' and
                (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
                raise ClientError('unsafe_ledger_permissions')
        else:
            os.close(fd)
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS attempts '
                        '(scope TEXT, id TEXT, body_hash TEXT, state TEXT, updated INTEGER, PRIMARY KEY(scope,id))')
        self.db.commit()

    def reserve(self, scope, identifier, body_hash):
        try:
            with self.db:
                self.db.execute("INSERT INTO attempts VALUES (?, ?, ?, 'pending', ?)",
                                (scope, identifier, body_hash, int(time.time())))
        except sqlite3.IntegrityError as exc:
            raise ClientError('uuid_already_attempted_reconcile_original_result_do_not_resend') from exc

    def finish(self, scope, identifier, state):
        with self.db:
            self.db.execute('UPDATE attempts SET state=?, updated=? WHERE scope=? AND id=?',
                            (state, int(time.time()), scope, identifier))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.db.close()


class SignedClient:
    def __init__(self, config, *, key=None, opener=None):
        server_raw = validate_identity_config(config)
        _, _, public_type = crypto()
        self.config = config
        self.key = key if key is not None else load_private_key(config)
        self.server_key = public_type.from_public_bytes(server_raw)
        self.opener = opener if opener is not None else make_opener(config)

    def call(self, tool=None, source=b'{}', *, operation_id=None):
        if tool is not None and tool not in ALL_TOOLS:
            raise ClientError('only_reviewed_qq_tools_are_available')
        if tool not in WRITE_TOOLS:
            return self._call(tool, source)
        body = compact_json_bytes(source)
        value = parse_json(body)
        id_field, lookup = WRITE_TOOLS[tool]
        identifier = value.get(id_field) if id_field else operation_id
        try:
            parsed = uuid.UUID(identifier) if isinstance(identifier, str) else None
        except ValueError:
            parsed = None
        if parsed is None or parsed.version != 4 or str(parsed) != identifier:
            raise ClientError('mutation_requires_existing_canonical_uuid4')
        # One family prevents using a new send route to bypass an ambiguous send.
        family = 'delivery' if tool in {'send_message', 'send_audio', 'send_favorite'} else tool
        namespace = digest(canonical([self.config['server_url'], self.config['client_key_id'],
                                      self.config['expected_qq_id'], family]))
        with AttemptLedger(self.config) as ledger:
            ledger.reserve(namespace, identifier, digest(canonical([tool]) + body))
            try:
                answer = self._call(tool, body)
            except Exception as exc:
                ledger.finish(namespace, identifier, 'unknown')
                return {'ok': False, 'error': type(exc).__name__, 'operation_id': identifier,
                        'mutation_state': 'unknown', 'automatic_retry': False, 'lookup_tool': lookup,
                        'detail': 'Outcome unknown. Reconcile the original ID; never generate a new ID to retry.'}
            ledger.finish(namespace, identifier, 'verified_response')
            answer.update(operation_id=identifier, automatic_retry=False, lookup_tool=lookup)
            # HTTP 200 is not evidence of delivery. Preserve the application state.
            answer['mutation_state'] = (answer['body'].get('state', 'verified_response')
                                        if isinstance(answer['body'], dict) else 'verified_response')
            return answer

    def _call(self, tool=None, source=b'{}'):
        config = self.config
        endpoint = '/qq/status' if tool is None else '/qq/tools/' + tool
        method = 'GET' if tool is None else 'POST'
        protocol = 'status' if tool is None else 'chat'
        body = b'' if tool is None else compact_json_bytes(source)
        nonce, stamp = b64(secrets.token_bytes(32)), str(int(time.time() * 1000))
        message = canonical([f'napcat-{protocol}-request-v1', config['server_url'], config['client_key_id'],
                             method, endpoint, stamp, nonce, digest(body)])
        headers = {'X-Dot-Key-Id': config['client_key_id'], 'X-Dot-Timestamp': stamp,
                   'X-Dot-Nonce': nonce, 'X-Dot-Signature': b64(self.key.sign(message)),
                   'Accept-Encoding': 'identity'}
        if tool is not None:
            headers.update({'Content-Type': 'application/json', 'Content-Length': str(len(body))})
        request = urllib.request.Request(config['server_url'] + endpoint, data=body if tool else None,
                                         headers=headers, method=method)
        code, response_headers, response_body = fetch(self.opener, request, config['timeout_seconds'],
                                                     4096 if tool is None else MAX_BODY)
        self.verify(code, response_headers, response_body, message, nonce, protocol)
        value = parse_json(response_body)
        if tool is None and code == 200:
            if not isinstance(value, dict) or set(value) != {'online'} or type(value['online']) is not bool:
                raise ClientError('unexpected_status_schema')
        return {'ok': 200 <= code < 300, 'http': code, 'response_signature_verified': True,
                'client_key_id': config['client_key_id'], 'expected_qq_id': config['expected_qq_id'],
                'qq_identity_verified': False, 'body': value,
                'identity_note': 'QQ binding is operator-confirmed; legacy status does not return a QQ ID.'}

    def verify(self, code, headers, body, request_message, nonce, protocol):
        config = self.config
        if headers.get('X-Dot-Server-Key-Id', '') != config['server_key_id']:
            raise ClientError('unexpected_server_key_id')
        request_hash = digest(request_message)
        if headers.get('X-Dot-Request-Hash', '') != request_hash:
            raise ClientError('response_request_binding_mismatch')
        stamp = headers.get('X-Dot-Response-Timestamp', '')
        if not re.fullmatch(r'[0-9]{13}', stamp) or abs(time.time() * 1000 - int(stamp)) > 30000:
            raise ClientError('stale_response_or_clock_skew')
        message = canonical([f'napcat-{protocol}-response-v1', config['server_url'], config['server_key_id'],
                             request_hash, stamp, nonce, str(code), digest(body)])
        try:
            self.server_key.verify(signature_bytes(headers.get('X-Dot-Response-Signature', '')), message)
        except ClientError:
            raise
        except Exception as exc:
            raise ClientError('invalid_response_signature') from exc


def doctor(config):
    errors = []
    fingerprint = None
    for check in (validate_origin, validate_identity_config):
        try:
            check(config)
        except (ClientError, ValueError) as exc:
            errors.append(str(exc))
    try:
        key = load_private_key(config)
        serialization, _, _ = crypto()
        raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        fingerprint = 'sha256:' + digest(raw)
    except ClientError as exc:
        errors.append(str(exc))
    except OSError:
        errors.append('private_key_not_available')
    except (ValueError, TypeError):
        errors.append('private_key_invalid_or_encrypted')
    return {'ok': not errors, 'network_requested': False, 'errors': sorted(set(errors)),
            'client_public_key_fingerprint': fingerprint,
            'credentials_created': False, 'qq_identity_verified': False,
            'detail': 'Offline checks only. QQ account binding requires server-side verification.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'config.json')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor', help='Offline config/key checks; no network, no key generation')
    sub.add_parser('probe', help='Optional unsigned HTTPS /qq/status reachability check; no credentials')
    sub.add_parser('status', help='Verified signed status; not a QQ account-ID assertion')
    for command, choices in [('read', READ_TOOLS), ('tool', ALL_TOOLS)]:
        entry = sub.add_parser(command, help='One explicit QQ call. Mutations require authorization; never retried.')
        entry.add_argument('tool', choices=sorted(choices))
        entry.add_argument('--body', type=Path, required=True)
        entry.add_argument('--operation-id', help='Existing UUIDv4 for collect_favorite local deduplication only')
    send = sub.add_parser('send', help='Explicit send_message with durable UUID ledger; never a test send')
    send.add_argument('--body', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        if args.command == 'doctor':
            result = doctor(config)
        elif args.command == 'probe':
            result = probe(config)
        else:
            source = b'{}' if args.command == 'status' else args.body.read_bytes()
            if len(source) > MAX_BODY:
                raise ClientError('request_too_large')
            tool = None if args.command == 'status' else 'send_message' if args.command == 'send' else args.tool
            result = SignedClient(config).call(tool, source, operation_id=getattr(args, 'operation_id', None))
    except ClientError as exc:
        result = {'ok': False, 'error': str(exc), 'automatic_retry': False}
    except Exception as exc:
        # Error URLs/proxy strings may contain secrets. Never print the original.
        result = {'ok': False, 'error': type(exc).__name__, 'automatic_retry': False,
                  'detail': 'Configuration, dependency, TLS or network failure. No alternate route was attempted.'}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
