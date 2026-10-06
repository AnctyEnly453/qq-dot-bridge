import {PRIMARY_PRIVATE} from './config.mjs';
import crypto from 'node:crypto';
import {requireConversation,scopeKey,validAccountId,validMessageId,snapshot} from './scoped_policy.mjs';
import {validRequestId,fail} from './tool_contract.mjs';

// Restricted own-message actions; no background I/O.
// A caller must declare intent before sending, then register the confirmed test send. QQ text,
// manual messages and unknown sends cannot grant action authority.
export function createTestMessageActions({store,policy,selfId,readMessage,call,clock=Date.now,allowMutations=false,testWindowEndsAt=null}) {
  if(!validAccountId(selfId)||typeof readMessage!=='function'||typeof call!=='function')throw TypeError('trusted action dependencies required');
  if(typeof allowMutations!=='boolean'||testWindowEndsAt!==null&&!Number.isSafeInteger(testWindowEndsAt))throw TypeError('trusted action window required');
  const db=store.db;
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const fresh=registeredAt=>{const now=clock();return Number.isSafeInteger(now)&&now>=registeredAt&&now-registeredAt<=120000;};
  db.exec('CREATE TABLE IF NOT EXISTS tool_own_tests(request_id TEXT PRIMARY KEY,scope TEXT,message_id TEXT,registered_at INTEGER);CREATE TABLE IF NOT EXISTS tool_test_intents(request_id TEXT PRIMARY KEY,scope TEXT,body_hash TEXT,declared_at INTEGER);CREATE TABLE IF NOT EXISTS tool_message_actions_v2(action_id TEXT PRIMARY KEY,body_hash TEXT,scope TEXT,request_id TEXT,state TEXT)');
  function active(){if(!allowMutations)fail(403,'message_actions_disabled');if(testWindowEndsAt!==null&&clock()>=testWindowEndsAt)fail(403,'test_window_closed');}
  const table=name=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  function owner(request_id){
    const group=table('tool_group_send_scope')&&db.prepare('SELECT group_id FROM tool_group_send_scope WHERE request_id=?').get(request_id);
    if(group)return 'group:'+group.group_id;
    const peer=table('tool_private_send_scope')&&db.prepare('SELECT peer_id FROM tool_private_send_scope WHERE request_id=?').get(request_id);
    return 'private:'+(peer?.peer_id??PRIMARY_PRIVATE);
  }
  function declareTestSend(input) {
    const v=snapshot(input);if(!object(v)||Object.keys(v).sort().join(',')!=='body_hash,conversation,purpose,request_id'||v.purpose!=='self_test'||!validRequestId(v.request_id)||typeof v.body_hash!=='string'||!/^([a-f0-9]{64})$/.test(v.body_hash))fail(400,'invalid_test_registration');
    const chat=requireConversation(policy,v.conversation,'send'),previous=db.prepare('SELECT * FROM tool_test_intents WHERE request_id=?').get(v.request_id);
    if(previous){if(previous.scope!==scopeKey(chat)||previous.body_hash!==v.body_hash)fail(409,'idempotency_conflict');return {request_id:v.request_id,declared_at:previous.declared_at};}
    if(db.prepare('SELECT request_id FROM sends WHERE request_id=?').get(v.request_id))fail(403,'test_intent_must_precede_send');
    if(db.prepare('SELECT COUNT(*) AS n FROM tool_test_intents').get().n>=1000)fail(503,'capacity_exceeded');
    db.prepare('INSERT INTO tool_test_intents VALUES(?,?,?,?)').run(v.request_id,scopeKey(chat),v.body_hash,clock());
    return {request_id:v.request_id,declared_at:clock()};
  }
  function registerTestSend(input) {
    const v=snapshot(input);if(!object(v)||Object.keys(v).sort().join(',')!=='conversation,purpose,request_id'||v.purpose!=='self_test'||!validRequestId(v.request_id))fail(400,'invalid_test_registration');
    const chat=requireConversation(policy,v.conversation,'send');
    const intent=db.prepare('SELECT * FROM tool_test_intents WHERE request_id=?').get(v.request_id);
    if(!intent||intent.scope!==scopeKey(chat))fail(403,'test_send_not_declared');
    if(clock()<intent.declared_at||clock()-intent.declared_at>120000)fail(403,'test_intent_expired');
    const sent=db.prepare('SELECT state,message_id,body_hash FROM sends WHERE request_id=?').get(v.request_id);
    if(!sent||sent.state!=='complete'||!validMessageId(sent.message_id)||owner(v.request_id)!==scopeKey(chat))fail(403,'test_send_not_confirmed');
    if(sent.body_hash!==intent.body_hash)fail(409,'test_send_body_mismatch');
    if(db.prepare('SELECT COUNT(*) AS n FROM tool_own_tests').get().n>=1000)fail(503,'capacity_exceeded');
    db.prepare('INSERT OR IGNORE INTO tool_own_tests VALUES(?,?,?,?)').run(v.request_id,scopeKey(chat),sent.message_id,intent.declared_at);
    return {conversation:chat,request_id:v.request_id,message_id:sent.message_id};
  }
  async function act(input,kind) {
    active();
    const v=snapshot(input),fields=['conversation','request_id','action_id',...(kind==='reaction'?['emoji_id','set']:[])];
    if(!object(v)||Object.keys(v).sort().join(',')!==fields.sort().join(',')||!validRequestId(v.action_id)||!validRequestId(v.request_id)||kind==='reaction'&&(typeof v.emoji_id!=='string'||!/^\d{1,10}$/.test(v.emoji_id)||typeof v.set!=='boolean'))fail(400,'invalid_request');
    const chat=requireConversation(policy,v.conversation,'send'),row=db.prepare('SELECT * FROM tool_own_tests WHERE request_id=?').get(v.request_id);
    if(!row||row.scope!==scopeKey(chat)||!fresh(row.registered_at))fail(403,'test_message_forbidden');
    // Normalize field order while retaining exact-body legacy v2 replays.
    const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const hash=digest({kind,conversation:chat,request_id:v.request_id,action_id:v.action_id,...(kind==='reaction'?{emoji_id:v.emoji_id,set:v.set}:{})});
    const legacyHash=digest({kind,...v}),matches=prior=>prior.body_hash===hash||prior.body_hash===legacyHash;
    const old=db.prepare('SELECT body_hash,state FROM tool_message_actions_v2 WHERE action_id=?').get(v.action_id);
    if(old){if(!matches(old))fail(409,'idempotency_conflict');return {action_id:v.action_id,state:old.state,observed_notice:false};}
    const raw=await readMessage({conversation:chat,message_id:row.message_id});
    active();
    requireConversation(policy,chat,'send');
    if(String(raw?.message_id)!==row.message_id||String(raw?.sender?.user_id??raw?.user_id)!==selfId||raw?.message_type!==chat.type||(chat.type==='group'?String(raw?.group_id)!==chat.id:String(raw?.peer_id??raw?.target_id)!==chat.id))fail(403,'test_message_provenance_failed');
    if(!fresh(row.registered_at))fail(403,'test_message_forbidden');
    if(db.prepare('SELECT COUNT(*) AS n FROM tool_message_actions_v2').get().n>=1000)fail(503,'capacity_exceeded');
    // Recheck after asynchronous provenance lookup: concurrent identical calls
    // cannot both reserve and mutate the same message.
    const reserved=db.prepare('INSERT OR IGNORE INTO tool_message_actions_v2 VALUES(?,?,?,?,?)').run(v.action_id,hash,scopeKey(chat),v.request_id,'unknown');
    if(!reserved.changes){const prior=db.prepare('SELECT body_hash,state FROM tool_message_actions_v2 WHERE action_id=?').get(v.action_id);if(!matches(prior))fail(409,'idempotency_conflict');return {action_id:v.action_id,state:prior.state,observed_notice:false};}
    try{await call(kind==='reaction'?'set_msg_emoji_like':'delete_msg',kind==='reaction'?{message_id:row.message_id,emoji_id:v.emoji_id,set:v.set}:{message_id:row.message_id});db.prepare("UPDATE tool_message_actions_v2 SET state='api_acknowledged' WHERE action_id=?").run(v.action_id);}catch{/* Unknown is never automatically repeated. */}
    return {action_id:v.action_id,state:db.prepare('SELECT state FROM tool_message_actions_v2 WHERE action_id=?').get(v.action_id).state,observed_notice:false};
  }
  function result(input){const v=snapshot(input);if(!object(v)||Object.keys(v).sort().join(',')!=='action_id,conversation'||!validRequestId(v.action_id))fail(400,'invalid_request');const chat=requireConversation(policy,v.conversation,'read_result'),row=db.prepare('SELECT scope,state FROM tool_message_actions_v2 WHERE action_id=?').get(v.action_id);return {action_id:v.action_id,state:row?.scope===scopeKey(chat)?row.state:'not_found',observed_notice:false};}
  return Object.freeze({declareTestSend,registerTestSend,result,react:input=>act(input,'reaction'),recall:input=>act(input,'recall')});
}

export function ingestRecallNotice(store,raw,{selfId}={}) {
  if(!validAccountId(selfId)||String(raw?.self_id)!==selfId||raw?.post_type!=='notice'||!['group_recall','friend_recall'].includes(raw?.notice_type))return {status:'ignored',transport_live:false};
  if(!validAccountId(String(raw.user_id))||raw.operator_id!==undefined&&!validAccountId(String(raw.operator_id)))return {status:'ignored',transport_live:false};
  const chat={type:raw.notice_type==='group_recall'?'group':'private',id:String(raw.notice_type==='group_recall'?raw.group_id:raw.user_id)};
  requireConversation(store.policy,chat,'read_info');
  const result=store.ingest(raw,{conversation:chat});
  const operator=validAccountId(String(raw.operator_id))?String(raw.operator_id):null,author=chat.type==='group'?String(raw.user_id):null;
  return {...result,transport_live:false,message_author_user_id:author,actor_user_id:operator,operator_user_id:operator,withdrawal_kind:operator&&author?(operator===author?'author_recalled':'operator_recalled'):'operator_unknown'};
}
