#!/usr/bin/env python3
"""Single entry point. Setup never creates keys, registers identities or contacts QQ."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent


def load_template():
    template = json.loads((ROOT.parent / 'config.example.json').read_text('utf-8'))
    return {'schema_version': 1, 'server_url': '',
            'client_key_id': template['client_key_id'],
            'private_key_file': template['client']['private_key_file'],
            'server_key_id': template['server_key_id'],
            'server_public_key_raw_base64': '', 'expected_qq_id': '',
            'account_binding_confirmed': False,
            'require_https_proxy': template['client']['require_https_proxy'],
            'timeout_seconds': 25,
            'state_directory': template['client']['state_directory']}


def setup(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-install', action='store_true',
                        help='Copy the template only; use already-approved installed dependencies')
    args = parser.parse_args(argv)
    config = ROOT / 'config.json'
    created = False
    try:
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'wb') as output:
            output.write((json.dumps(load_template(), ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
        created = True
    if not args.skip_install:
        environment = ROOT / '.venv'
        if environment.is_symlink():
            raise RuntimeError('Refusing a symlinked .venv')
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        # Use the host-approved pip/index configuration. Do not change proxies,
        # certificates, package indexes, trusted-host settings or network policy.
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                        '-r', str(ROOT / 'requirements.txt')], check=True)
    print(json.dumps({'ok': True, 'config_created': created,
                      'credentials_created': False, 'server_changed': False,
                      'next': 'Edit config.json; run: python3 qq.py doctor'}, ensure_ascii=False))
    return 0


def main():
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 or newer is required')
    if len(sys.argv) > 1 and sys.argv[1] == 'setup':
        return setup(sys.argv[2:])
    python = ROOT / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if python.exists() and Path(sys.prefix).resolve() != (ROOT / '.venv').resolve():
        return subprocess.call([str(python), str(ROOT / 'qq.py'), *sys.argv[1:]])
    from client import main as client_main
    return client_main(sys.argv[1:])


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(json.dumps({'ok': False, 'error': type(exc).__name__,
                          'detail': 'Setup failed. Review the local installer error; do not bypass access or TLS restrictions.'}))
        sys.exit(1)
