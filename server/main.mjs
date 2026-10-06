import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CONFIG,CONFIG_PATH,validateConfig,localPath,statePath} from './src/config.mjs';
import {Store,Engine,Failure,createGateway} from './src/chat_bridge.mjs';
import {FixedToolAdapter} from './src/fixed_tool_adapter.mjs';
import {createScopedConversationPolicy} from './src/scoped_policy.mjs';
import {ScopedEventStore} from './src/scoped_events.mjs';
import {createScopedHistorySource} from './src/scoped_collector.mjs';
import {createScopedMediaTransport} from './src/scoped_media_transport.mjs';
import {createImageValidator} from './src/media_adapter.mjs';
import {validateImageBytes} from './src/media_messages.mjs';
import {createUnifiedToolRuntime} from './src/unified_tool_runtime.mjs';
import {createSignedActionRuntime} from './src/signed_action_runtime.mjs';
import {BoundedGroupBackfill} from './src/bounded_group_backfill.mjs';
import {createJpegStager} from './src/jpeg_staging.mjs';
import {startScopedNoticeSource} from './src/scoped_notice_source.mjs';

function keyFile(filename, isPrivate) {
  const target = localPath(filename), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || isPrivate && (stat.mode & 0o077)) throw new Error('unsafe_key_permissions');
  const key = (isPrivate ? crypto.createPrivateKey : crypto.createPublicKey)(fs.readFileSync(target));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ed25519_key_required');
  return key;
}
export async function start() {
  process.umask(0o077);
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('copy_and_complete_config_first');
  validateConfig(CONFIG);
  const publicKey = keyFile(CONFIG.client_public_key_file, false);
  const privateKey = keyFile(CONFIG.server_private_key_file, true);
  fs.mkdirSync(localPath(CONFIG.state_directory), {recursive:true, mode:0o700});
  const policy = createScopedConversationPolicy({allowedGroups:CONFIG.allowed_groups, allowedPrivates:CONFIG.allowed_privates});
  const errorFactory = (status, code) => new Failure(status, code);
  const decoder = createImageValidator({errorFactory});
  const adapter = new FixedToolAdapter(localPath(CONFIG.napcat.token_file), {policy, jpegStager:createJpegStager()});
  // Bind each running instance to one actual NapCat account before exposing it.
  async function status() {
    const identity = await adapter._transport('get_login_info', {}, 16384);
    if (String(identity?.user_id) !== CONFIG.self_id) throw new Failure(503, 'account_identity_mismatch');
    const health = await adapter._transport('get_status', {}, 16384);
    return {online:health?.online === true};
  }
  await status();
  const sends = new Store(statePath('sends.sqlite3'));
  const engine = new Engine(sends, adapter, (bytes,mime) => validateImageBytes(bytes,mime,{decodeImage:decoder,errorFactory}));
  const queue = new ScopedEventStore(statePath('events.sqlite3'), {policy,maxRows:1000});
  const backfill = new BoundedGroupBackfill(queue,adapter,{selfId:CONFIG.self_id,errorFactory});
  const source = createScopedHistorySource({readLatest:async input => {
    const rows=await adapter.readLatest(input);backfill.observeNativeLive(input.conversation,rows);return rows;
  }});
  const runtime = createUnifiedToolRuntime({queue,source,engine,adapter,mediaAdapter:createScopedMediaTransport({store:backfill.store,adapter}),
    decodeImage:decoder,errorFactory,selfId:CONFIG.self_id,backfill});
  const actions = createSignedActionRuntime({policy,selfId:CONFIG.self_id,adapter,store:sends,queue,facade:runtime.facade,
    decodeImage:decoder,errorFactory,enabled:CONFIG.features.actions,audioEnabled:CONFIG.features.audio});
  const notices = CONFIG.features.notices ? startScopedNoticeSource(actions.notices) : null;
  const nonces = new Store(statePath('nonces.sqlite3'));
  // Authorization/signatures, bounded tools, and native transport are distinct layers.
  const server = createGateway({publicKey,privateKey,store:nonces,status,
    backend:input=>engine.send(input),events:runtime.legacyEvents,media:runtime.legacyMedia,
    tools:{...runtime.handlers,...actions.handlers}});
  const chats=[...CONFIG.allowed_privates.map(id=>({type:'private',id})),...CONFIG.allowed_groups.map(id=>({type:'group',id}))];
  let collecting=false;
  const collect=async()=>{if(collecting)return;collecting=true;try{for(const chat of chats)await runtime.reads.collector.collect(chat).catch(()=>{});}finally{collecting=false;}};
  const timer=setInterval(()=>void collect(),2000);timer.unref();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(CONFIG.listen_port,'127.0.0.1',resolve);});
  void collect();
  let stopped=false;
  const close=()=>{if(stopped)return;stopped=true;clearInterval(timer);notices?.stop();server.close();runtime.close();actions.close();queue.close();sends.close();nonces.close();};
  process.once('SIGTERM',close);process.once('SIGINT',close);
  process.stdout.write(JSON.stringify({listening:'127.0.0.1',port:CONFIG.listen_port})+'\n');
  return {server,close};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start().catch(error=>{
  process.stderr.write((/^[a-z_]+$/.test(error.message)?error.message:'bridge_startup_failed')+'\n');process.exitCode=1;
});
