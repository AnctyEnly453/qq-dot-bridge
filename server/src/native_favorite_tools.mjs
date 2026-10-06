import crypto from 'node:crypto';import {snapshot,requireConversation,scopeKey,validAccountId} from './scoped_policy.mjs';import {exact,validRequestId,fail} from './tool_contract.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
// Guarded native QQ favorites adapter, not a generic native action route.
// Bounded detail reads are projected to the selected item's MD5/resId only.
export function createNativeFavoriteTools({db,policy,selfId,exportFavorite,call,stage,removeStaged,allowAdd=()=>false}={}){
 if(!validAccountId(selfId)||![exportFavorite,call,stage,removeStaged,allowAdd].every(f=>typeof f==='function')||typeof db?.prepare!=='function')throw TypeError('trusted native favorite dependencies required');
 db.exec('CREATE TABLE IF NOT EXISTS tool_native_favorite_ops(request_id TEXT PRIMARY KEY,scope TEXT NOT NULL,favorite_id TEXT NOT NULL,sha TEXT NOT NULL,md5 TEXT NOT NULL,state TEXT NOT NULL,retcode INTEGER,res_id TEXT,stage_path TEXT);CREATE TABLE IF NOT EXISTS tool_native_favorite_not_attempted(request_id TEXT PRIMARY KEY,evidence TEXT NOT NULL)');
 const authorize=(v,op='read_info')=>requireConversation(policy,v,op);
 const project=row=>({request_id:row.request_id,favorite_id:row.favorite_id,state:row.state,source_sha256:row.sha,md5:row.md5,retcode:row.retcode,res_id:row.res_id,collection:'qq_native',gif_client_playback_verified:false});
 async function identity(chat){const login=await call('get_login_info',{});authorize(chat);if(String(login?.user_id)!==selfId)fail(403,'account_identity_mismatch');}
 async function find(md5){const raw=snapshot(await call('fetch_custom_face_detail',{count:10}),{maxBytes:128*1024,maxNodes:5000,maxArray:100,maxDepth:10});if(!Array.isArray(raw)||raw.length>10)fail(502,'invalid_native_favorite_response');
  const item=raw.find(v=>v&&typeof v==='object'&&(['md5','emojiMd5','fileMd5'].some(k=>typeof v[k]==='string'&&v[k].toLowerCase()===md5)||typeof v.resId==='string'&&v.resId.toLowerCase().includes('_'+md5+'_')));
  return item?{res_id:typeof item.resId==='string'&&item.resId.length<=256?item.resId:null,scanned:raw.length}:null;
 }
 async function add(input){const v=snapshot(input);exact(v,['conversation','favorite_id','request_id']);const chat=authorize(v.conversation,'media');if(!validRequestId(v.request_id))fail(400,'invalid_request');const previous=db.prepare('SELECT * FROM tool_native_favorite_ops WHERE request_id=?').get(v.request_id);
  if(previous){if(previous.scope!==scopeKey(chat)||previous.favorite_id!==v.favorite_id)fail(409,'idempotency_conflict');const proof=db.prepare('SELECT evidence FROM tool_native_favorite_not_attempted WHERE request_id=?').get(v.request_id);if(previous.state!=='not_attempted'||proof?.evidence!=='invalid_internal_timeout_before_credential_and_io')return project(previous);}
  if(allowAdd(chat)!==true)fail(403,'native_favorite_add_disabled');
  const media=snapshot(await exportFavorite({conversation:chat,favorite_id:v.favorite_id})),bytes=Buffer.from(media.data_base64??'','base64');authorize(chat,'media');if(!bytes.length||bytes.length>2*1024*1024||media.sha256!==hash(bytes)||!['image/png','image/jpeg','image/gif','image/webp'].includes(media.mime))fail(400,'invalid_favorite_media');
  const md5=crypto.createHash('md5').update(bytes).digest('hex');if(previous&&(previous.sha!==media.sha256||previous.md5!==md5))fail(409,'idempotency_conflict');await identity(chat);const found=await find(md5);authorize(chat,'media');if(allowAdd(chat)!==true)fail(403,'native_favorite_add_disabled');
  if(db.prepare('SELECT COUNT(*) AS n FROM tool_native_favorite_ops').get().n>=1000)fail(503,'capacity_exceeded');
  const reserved=previous?db.prepare("UPDATE tool_native_favorite_ops SET state=?,res_id=? WHERE request_id=? AND state='not_attempted'").run(found?'already_present':'unknown',found?.res_id??null,v.request_id):db.prepare('INSERT OR IGNORE INTO tool_native_favorite_ops VALUES(?,?,?,?,?,?,NULL,?,NULL)').run(v.request_id,scopeKey(chat),v.favorite_id,media.sha256,md5,found?'already_present':'unknown',found?.res_id??null);
  if(!reserved.changes)return add(v);if(previous?.stage_path){await removeStaged(previous.stage_path);db.prepare('UPDATE tool_native_favorite_ops SET stage_path=NULL WHERE request_id=?').run(v.request_id);}if(found)return project(db.prepare('SELECT * FROM tool_native_favorite_ops WHERE request_id=?').get(v.request_id));
  let path;try{
   path=await stage({bytes:Buffer.from(bytes),mime:media.mime,sha256:media.sha256});if(typeof path!=='string'||!/^\/tmp\/dot-native-favorites\/[a-f0-9]{64}\.(gif|png|jpg|webp)$/.test(path))fail(503,'invalid_native_stage');
   db.prepare('UPDATE tool_native_favorite_ops SET stage_path=? WHERE request_id=?').run(path,v.request_id);authorize(chat,'media');if(allowAdd(chat)!==true)fail(403,'native_favorite_add_disabled');await identity(chat);
   // Existing transport acknowledges only status=ok and retcode=0.
   await call('add_custom_face',{file:path,md5,file_size:String(bytes.length),is_origin:true,is_mark_face:false});
   db.prepare("UPDATE tool_native_favorite_ops SET state='api_acknowledged',retcode=0 WHERE request_id=?").run(v.request_id);
   const confirmed=await find(md5);authorize(chat);if(confirmed){db.prepare("UPDATE tool_native_favorite_ops SET state='verified',res_id=? WHERE request_id=?").run(confirmed.res_id,v.request_id);await removeStaged(path);db.prepare('UPDATE tool_native_favorite_ops SET stage_path=NULL WHERE request_id=?').run(v.request_id);}
  }catch{/* Ambiguous native writes cannot be automatically retried/deleted. */}
  return project(db.prepare('SELECT * FROM tool_native_favorite_ops WHERE request_id=?').get(v.request_id));
 }
 async function result(input,{refresh=false}={}){const v=snapshot(input);exact(v,['conversation','request_id']);const chat=authorize(v.conversation);if(!validRequestId(v.request_id))fail(400,'invalid_request');let row=db.prepare('SELECT * FROM tool_native_favorite_ops WHERE request_id=? AND scope=?').get(v.request_id,scopeKey(chat));if(!row)return {request_id:v.request_id,state:'not_found'};
  if(refresh&&!['verified','already_present'].includes(row.state)){await identity(chat);const found=await find(row.md5);authorize(chat);if(found){db.prepare("UPDATE tool_native_favorite_ops SET state='verified',res_id=? WHERE request_id=?").run(found.res_id,v.request_id);if(row.stage_path)await removeStaged(row.stage_path);db.prepare('UPDATE tool_native_favorite_ops SET stage_path=NULL WHERE request_id=?').run(v.request_id);row=db.prepare('SELECT * FROM tool_native_favorite_ops WHERE request_id=?').get(v.request_id);}}
  return project(row);
 }
 return Object.freeze({add,result,verify:input=>result(input,{refresh:true})});
}
