import crypto from 'node:crypto';import {snapshot,requireConversation,scopeKey,validAccountId,validMessageId} from './scoped_policy.mjs';import {exact,validRequestId,fail} from './tool_contract.mjs';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
// Separate reaction-only capability for an explicitly selected peer message.
// It neither claims self-test ownership nor exports any recall/delete operation.
export function createPeerReaction({db,policy,selfId,readMessage,getIdentity,call,approvedTarget=null,clock=Date.now}={}){
 if(!validAccountId(selfId)||![readMessage,getIdentity,call].every(x=>typeof x==='function'))throw TypeError('trusted reaction dependencies required');
 const grant=approvedTarget===null?null:snapshot(approvedTarget);if(grant){exact(grant,['conversation','message_id','author_id','text_sha256','expires_at']);if(grant.conversation?.type!=='group'||!validMessageId(grant.message_id)||!validAccountId(grant.author_id)||grant.author_id===selfId||typeof grant.text_sha256!=='string'||!/^[a-f0-9]{64}$/.test(grant.text_sha256)||!Number.isSafeInteger(grant.expires_at))throw TypeError('exact trusted peer reaction grant required');}
 db.exec('CREATE TABLE IF NOT EXISTS tool_peer_reactions(action_id TEXT PRIMARY KEY,scope TEXT NOT NULL,message_id TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL)');
 const authorize=v=>{const chat=requireConversation(policy,v,'send');if(chat.type!=='group')fail(403,'peer_reaction_scope_forbidden');return chat;};
 const active=()=>{if(!grant)fail(403,'peer_reaction_disabled');const now=clock();if(!Number.isSafeInteger(now)||now<0||now>=grant.expires_at)fail(403,'reaction_window_closed');};
 async function react(input){active();const v=snapshot(input);exact(v,['conversation','message_id','action_id','emoji_id']);const chat=authorize(v.conversation);
  if(!validRequestId(v.action_id)||v.emoji_id!=='14'||v.message_id!==grant.message_id||scopeKey(chat)!==scopeKey(grant.conversation))fail(403,'peer_reaction_target_forbidden');
  // New hashes normalize request keys; exact-body legacy hashes remain replayable.
  const hash=sha(JSON.stringify({conversation:chat,message_id:v.message_id,action_id:v.action_id,emoji_id:v.emoji_id,author_id:grant.author_id,text_sha256:grant.text_sha256})),legacyHash=sha(JSON.stringify({...v,author_id:grant.author_id,text_sha256:grant.text_sha256}));const result=()=>{const r=db.prepare('SELECT * FROM tool_peer_reactions WHERE action_id=?').get(v.action_id);if(r?.body_hash!==hash&&r?.body_hash!==legacyHash)fail(409,'idempotency_conflict');return {action_id:v.action_id,message_id:r.message_id,emoji_id:'14',state:r.state};};
  if(db.prepare('SELECT 1 FROM tool_peer_reactions WHERE action_id=?').get(v.action_id))return result();
  const identity=await getIdentity();active();authorize(chat);if(String(identity?.user_id)!==selfId)fail(403,'account_identity_mismatch');
  const raw=await readMessage({conversation:chat,message_id:v.message_id});active();authorize(chat);
  const author=String(raw?.sender?.user_id??raw?.user_id),text=Array.isArray(raw?.message)?raw.message.filter(p=>p.type==='text').map(p=>p.data?.text??'').join(''):null;
  if(String(raw?.message_id)!==grant.message_id||raw?.message_type!=='group'||String(raw?.group_id)!==chat.id||author!==grant.author_id||author===selfId||text===null||sha(text)!==grant.text_sha256)fail(403,'peer_message_provenance_failed');
  if(db.prepare('SELECT COUNT(*) AS n FROM tool_peer_reactions').get().n>=1000)fail(503,'capacity_exceeded');const reservation=db.prepare("INSERT OR IGNORE INTO tool_peer_reactions VALUES(?,?,?,?,'unknown')").run(v.action_id,scopeKey(chat),v.message_id,hash);if(!reservation.changes)return result();
  try{const answer=await call('set_msg_emoji_like',{message_id:v.message_id,emoji_id:'14',set:true}),rejected=answer?.result===false||Number.isSafeInteger(answer?.result)&&answer.result!==0;db.prepare('UPDATE tool_peer_reactions SET state=? WHERE action_id=?').run(rejected?'upstream_rejected':'api_acknowledged',v.action_id);}catch{/* Never repeat ambiguous mutations. */}return result();
 }
 function result(input){const v=snapshot(input);exact(v,['conversation','action_id']);const chat=requireConversation(policy,v.conversation,'read_result');if(!validRequestId(v.action_id))fail(400,'invalid_request');const row=db.prepare('SELECT * FROM tool_peer_reactions WHERE action_id=? AND scope=?').get(v.action_id,scopeKey(chat));return row?{action_id:v.action_id,message_id:row.message_id,emoji_id:'14',state:row.state}:{action_id:v.action_id,state:'not_found'};}
 return Object.freeze({react,result});
}
