// Export public connection information only. No private key is copied or created.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {CONFIG,validateConfig,localPath} from '../server/src/config.mjs';
if (process.argv.length !== 3) throw new Error('usage: QQ_BRIDGE_CONFIG=config.json node scripts/export-client-config.mjs OUTPUT');
validateConfig(CONFIG);
const key=crypto.createPublicKey(fs.readFileSync(localPath(CONFIG.server_private_key_file)));
if(key.asymmetricKeyType!=='ed25519')throw new Error('ed25519_key_required');
const raw=key.export({format:'jwk'}).x;
const output={schema_version:1,server_url:CONFIG.audience,client_key_id:CONFIG.client_key_id,
  private_key_file:CONFIG.client.private_key_file,server_key_id:CONFIG.server_key_id,
  server_public_key_raw_base64:Buffer.from(raw,'base64url').toString('base64'),expected_qq_id:CONFIG.self_id,
  account_binding_confirmed:false,require_https_proxy:CONFIG.client.require_https_proxy,
  timeout_seconds:25,state_directory:CONFIG.client.state_directory};
fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write('Public client configuration exported; verify account binding before enabling.\n');
