import {PRIMARY_PRIVATE} from './config.mjs';
import crypto from 'node:crypto';import {snapshot,requireConversation,scopeKey} from './scoped_policy.mjs';import {exact,validRequestId,validMessageId,delivery,boundedWait,fail} from './tool_contract.mjs';import {AUDIO_LIMITS} from './audio_processing.mjs';import {compactStringify} from './wire_json.mjs';
import {rejectedDelivery,recordPreSendRejection,SEND_REJECTION_CODES} from './send_failures.mjs';
export function captureAudio(input,policy){
 const v=snapshot(input);const conversation=requireConversation(policy,v?.conversation,'send');exact(v,['conversation','request_id','audio']);if(!validRequestId(v.request_id))fail(400,'invalid_request');exact(v.audio,['mime','data_base64']);
 const {mime,data_base64}=v.audio;if(!AUDIO_LIMITS.mimes.includes(mime)||typeof data_base64!=='string'||!data_base64.length||data_base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data_base64))fail(400,'invalid_audio');
 if(data_base64.length>4*Math.ceil(AUDIO_LIMITS.bytes/3))fail(413,'audio_too_large');const bytes=Buffer.from(data_base64,'base64');if(bytes.toString('base64')!==data_base64)fail(400,'invalid_audio');if(bytes.length>AUDIO_LIMITS.bytes)fail(413,'audio_too_large');
 return {conversation,request_id:v.request_id,audio:{mime,data_base64},bytes,messages:[{type:'audio',mime,data_base64}]};
}
export const audioStoreValue=v=>({target:v.conversation.type==='group'?{type:'group',id:v.conversation.id}:v.conversation.id,request_id:v.request_id,messages:v.messages});
export const audioBodyHash=v=>crypto.createHash('sha256').update(compactStringify(audioStoreValue(v))).digest('hex');
export function createAudioSender({store,policy,groupScope,processAudio,stage,removeStaged,sendAudio,getIdentity,selfId,enabled=false,timeoutMs=10000,clock=Date.now}={}){
 if(![processAudio,stage,removeStaged,sendAudio,getIdentity].every(f=>typeof f==='function'))throw TypeError('trusted audio dependencies required');const db=store.db;
 db.exec('CREATE TABLE IF NOT EXISTS tool_audio_sends(request_id TEXT PRIMARY KEY,scope TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,metadata TEXT,stage_path TEXT,created_at INTEGER NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS tool_private_send_scope(request_id TEXT PRIMARY KEY,peer_id TEXT NOT NULL,body_hash TEXT NOT NULL)');
 const authorize=v=>requireConversation(policy,v,'send');
 async function identity(){const result=await getIdentity();if(String(result?.user_id)!==selfId)fail(403,'account_identity_mismatch');}
 function cached(v){const row=db.prepare('SELECT * FROM tool_audio_sends WHERE request_id=?').get(v.request_id);if(!row)return null;if(row.scope!==scopeKey(v.conversation)||row.body_hash!==audioBodyHash(v))fail(409,'idempotency_conflict');const sent=db.prepare('SELECT body_hash,state,message_id FROM sends WHERE request_id=?').get(v.request_id);if(sent&&sent.body_hash!==row.body_hash)fail(409,'idempotency_conflict');if(sent?.state==='complete'&&validMessageId(sent.message_id))return delivery(v.request_id,'sent',sent.message_id);return rejectedDelivery(store,v.request_id,row.body_hash)??delivery(v.request_id,'unknown');}
 function reserve(v,metadata){const value=audioStoreValue(v),hash=audioBodyHash(v);if(db.prepare('SELECT request_id FROM sends WHERE request_id=?').get(v.request_id))fail(409,'idempotency_conflict');if(db.prepare('SELECT COUNT(*) AS n FROM tool_audio_sends').get().n>=1000)fail(503,'capacity_exceeded');
  db.prepare("INSERT INTO tool_audio_sends VALUES(?,?,?,'pending',?,NULL,?)").run(v.request_id,scopeKey(v.conversation),hash,JSON.stringify(metadata),clock());
  if(v.conversation.type==='group')groupScope.reserve(v);
  else{const bound=db.prepare('SELECT peer_id FROM tool_private_send_scope WHERE request_id=?').get(v.request_id);if(bound)fail(409,'idempotency_conflict');if(v.conversation.id!==PRIMARY_PRIVATE)db.prepare('INSERT INTO tool_private_send_scope VALUES(?,?,?)').run(v.request_id,v.conversation.id,hash);store.reserve(value);}
 }
 async function send(input){const v=captureAudio(input,policy),known=cached(v);if(known)return known;if(!enabled)fail(403,'audio_send_disabled');
  // Reserve once before expensive decoding: polling during conversion must
  // report unknown, never not_found while a later native send is still possible.
  reserve(v,{});
  const attempt=Promise.resolve().then(async()=>{let path,nativeStarted=false,phase='decode';try{
    const converted=await processAudio(Buffer.from(v.bytes),v.audio.mime);db.prepare('UPDATE tool_audio_sends SET metadata=? WHERE request_id=?').run(JSON.stringify(converted.metadata),v.request_id);authorize(v.conversation);await identity();authorize(v.conversation);phase='stage';
    path=await stage({request_id:v.request_id,bytes:converted.bytes,sha256:converted.metadata.output_sha256});if(typeof path!=='string'||!new RegExp('^/tmp/dot-audio-send/'+v.request_id+'-[a-f0-9]{64}\\.wav$').test(path))throw Error('invalid stage');db.prepare('UPDATE tool_audio_sends SET stage_path=? WHERE request_id=?').run(path,v.request_id);
    authorize(v.conversation);await identity();authorize(v.conversation);nativeStarted=true;const answer=await sendAudio({conversation:v.conversation,path}),id=answer?.message_id;
    if((typeof id!=='string'&&typeof id!=='number')||typeof id==='number'&&!Number.isSafeInteger(id)||!validMessageId(String(id)))throw Error('invalid audio ACK');store.complete(v.request_id,String(id));db.prepare("UPDATE tool_audio_sends SET state='complete' WHERE request_id=?").run(v.request_id);
    try{await removeStaged(path);db.prepare('UPDATE tool_audio_sends SET stage_path=NULL WHERE request_id=?').run(v.request_id);}catch{/* Confirmed send remains confirmed. */}
    return delivery(v.request_id,'sent',String(id));
   }catch(e){const rejected=nativeStarted?store.reject?.(v.request_id,e):recordPreSendRejection(store,v.request_id,SEND_REJECTION_CODES.includes(e?.code)?e.code:phase==='decode'?'audio_unavailable':'audio_staging_failed');
    db.prepare("UPDATE tool_audio_sends SET state=? WHERE request_id=? AND state!='complete'").run(rejected?'rejected':'unknown',v.request_id);
    if(rejected&&path)try{await removeStaged(path);db.prepare('UPDATE tool_audio_sends SET stage_path=NULL WHERE request_id=?').run(v.request_id);}catch{}
    return rejected?rejectedDelivery(store,v.request_id,audioBodyHash(v)):delivery(v.request_id,'unknown');}
  });return boundedWait(attempt,timeoutMs,()=>delivery(v.request_id,'unknown'));
 }
 return Object.freeze({send});
}
