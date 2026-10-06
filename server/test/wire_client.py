"""Offline-only loopback interoperability fixture; never installed as a client."""
import base64
import json
from pathlib import Path
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'client'))
import client
from cryptography.hazmat.primitives import serialization

fixture = json.load(sys.stdin)
key = serialization.load_pem_private_key(fixture['private'].encode(), password=None)
config = fixture['config']
config['_directory'] = Path(fixture['temporary_directory'])

class LoopbackFixture:
    def open(self, request, timeout):
        # The Node test owns this local socket. Production client has no such route.
        url = 'http://127.0.0.1:' + str(fixture['port']) + request.full_url[len(config['server_url']):]
        req = urllib.request.Request(url, data=request.data, method=request.get_method(), headers=dict(request.header_items()))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(req, timeout=timeout)

api = client.SignedClient(config, key=key, opener=LoopbackFixture())
status = api.call()
assert status['body'] == {'online': True} and status['response_signature_verified']
info = api.call('get_chat_info', b'{"conversation":{"type":"private","id":"1000000001"}}')
assert info['body']['name'] == 'synthetic fixture' and info['response_signature_verified']
print(json.dumps({'status_verified': True, 'tool_verified': True}))
