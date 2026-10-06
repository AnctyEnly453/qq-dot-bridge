import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CONFIG_PATH = path.resolve(process.env.QQ_BRIDGE_CONFIG || path.join(PROJECT_ROOT, 'config.json'));
const defaults = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.example.json'), 'utf8'));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export function validateConfig(input, {deployment = true} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== Object.keys(defaults).sort().join(',') || input.schema_version !== 1) throw new Error('invalid_config_schema');
  const account = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value) && Number.isSafeInteger(Number(value));
  const ids = values => Array.isArray(values) && values.length <= 16 && new Set(values).size === values.length && values.every(account);
  if (!ids(input.allowed_privates) || !ids(input.allowed_groups)) throw new Error('invalid_allowlist');
  if (deployment && (!account(input.self_id) || input.allowed_privates.length + input.allowed_groups.length === 0)) throw new Error('account_and_allowlist_required');
  for (const key of ['client_key_id', 'server_key_id']) if (typeof input[key] !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input[key])) throw new Error('invalid_key_id');
  if (deployment) {
    if (typeof input.audience !== 'string') throw new Error('invalid_audience');
    const url = new URL(input.audience);
    if (url.protocol !== 'https:' || url.origin !== input.audience || url.username || url.password) throw new Error('audience_must_be_exact_https_origin');
  }
  if (!Number.isInteger(input.listen_port) || input.listen_port < 1024 || input.listen_port > 65535) throw new Error('invalid_listen_port');
  for (const key of ['state_directory', 'client_public_key_file', 'server_private_key_file', 'python']) {
    if (typeof input[key] !== 'string' || !input[key] || /[\x00\r\n]/.test(input[key])) throw new Error('invalid_local_path');
  }
  const n = input.napcat;
  if (!n || Object.keys(n).sort().join(',') !== Object.keys(defaults.napcat).sort().join(',') ||
      typeof n.container !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n.container) ||
      !Number.isInteger(n.http_port) || n.http_port < 1 || n.http_port > 65535 ||
      typeof n.token_file !== 'string' || !n.token_file || /[\x00\r\n]/.test(n.token_file) ||
      typeof n.cache_mount !== 'string' || typeof n.cache_container_path !== 'string' ||
      !n.cache_container_path.startsWith('/') || /[\x00\r\n]/.test(n.cache_mount + n.cache_container_path)) throw new Error('invalid_napcat_config');
  if (!input.features || Object.keys(input.features).sort().join(',') !== 'actions,audio,notices' ||
      Object.values(input.features).some(value => typeof value !== 'boolean')) throw new Error('invalid_features');
  if (!input.client || Object.keys(input.client).sort().join(',') !== Object.keys(defaults.client).sort().join(',') ||
      typeof input.client.require_https_proxy !== 'boolean') throw new Error('invalid_client_config');
  for (const key of ['private_key_file','state_directory']) {
    const value=input.client[key];
    if (typeof value !== 'string' || !value || /[\x00\r\n]/.test(value) || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('invalid_client_path');
  }
  return input;
}
export const CONFIG = freeze(fs.existsSync(CONFIG_PATH) ? validateConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')), {deployment: false}) : defaults);
export const localPath = name => path.resolve(path.dirname(CONFIG_PATH), name);
export const statePath = name => path.join(localPath(CONFIG.state_directory), name);
export const sourcePath = name => fileURLToPath(new URL(name, import.meta.url));
export const PRIMARY_PRIVATE = CONFIG.allowed_privates[0] ?? '';
export const SECOND_PRIVATE = CONFIG.allowed_privates[1] ?? '';
export const PRIMARY_GROUP = CONFIG.allowed_groups[0] ?? '';
export const BOT_ID = CONFIG.self_id;
