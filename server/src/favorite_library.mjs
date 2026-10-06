import crypto from 'node:crypto';
import {snapshot,requireConversation,scopeKey,validMessageId,validFileId} from './scoped_policy.mjs';
import {exact,validCursor,validRequestId,validateDelivery,fail} from './tool_contract.mjs';
import {validateImageBytes,MEDIA_LIMITS} from './image_validation.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const formats={'image/png':'PNG','image/jpeg':'JPEG','image/gif':'GIF','image/webp':'WEBP'};
const favoriteId=id=>typeof id==='string'&&/^fv1:[a-f0-9]{64}$/.test(id);
const same=(a,b)=>a?.type===b.type&&a?.id===b.id;
const chatFrom=scope=>{const [type,id]=scope.split(':');return {type,id};};

// Private tool collection, not a QQ official favorites mirror. Construction and
// local queries perform no I/O. Host supplies protected SQLite, scoped signed
// client, full decoder and its own send authorization/window callback.
export function createFavoriteLibrary({db,client,policy,decodeImage,clock=Date.now,allowSend=()=>false}={}){
  if(typeof db?.prepare!=='function'||typeof client?.view_media!=='function'||typeof client?.send_message!=='function'||typeof decodeImage!=='function'||typeof allowSend!=='function')throw TypeError('trusted favorite dependencies required');
  db.exec(`CREATE TABLE IF NOT EXISTS tool_favorites(id TEXT PRIMARY KEY,scope TEXT NOT NULL,mime TEXT NOT NULL,sha TEXT NOT NULL,bytes BLOB,title TEXT NOT NULL,tags TEXT NOT NULL,meta TEXT NOT NULL,collected_at INTEGER NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_favorite_origins(favorite_id TEXT NOT NULL,scope TEXT NOT NULL,cursor TEXT NOT NULL,message_id TEXT NOT NULL,file_id TEXT NOT NULL,collected_at INTEGER NOT NULL,PRIMARY KEY(favorite_id,cursor,message_id,file_id));
    CREATE TABLE IF NOT EXISTS tool_favorite_sends(request_id TEXT PRIMARY KEY,favorite_id TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS tool_favorite_revocations(scope TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(scope,message_id));`);
  const authorized=(chat,op='read_info')=>requireConversation(policy,chat,op);
  function metadata(row){return {favorite_id:row.id,conversation:chatFrom(row.scope),title:row.title,tags:JSON.parse(row.tags),mime:row.mime,sha256:row.sha,size_bytes:row.bytes?.length??0,...JSON.parse(row.meta),collected_at:row.collected_at,state:row.state,
    sources:db.prepare('SELECT cursor,message_id,file_id,collected_at FROM tool_favorite_origins WHERE favorite_id=? ORDER BY collected_at,cursor').all(row.id),live_recall_revocation:false};}
  function rowFor(chat,id){if(!favoriteId(id))fail(400,'invalid_favorite');const row=db.prepare('SELECT * FROM tool_favorites WHERE id=? AND scope=?').get(id,scopeKey(chat));if(!row)fail(404,'favorite_not_found');return row;}
  function verified(row){if(row.state!=='available'||!row.bytes)fail(404,'favorite_unavailable');const bytes=Buffer.from(row.bytes);if(sha(bytes)!==row.sha)fail(503,'favorite_corrupt');return bytes;}
  async function collect(input){
    const v=snapshot(input,{maxBytes:8192}),optional=['title','tags'].filter(k=>Object.hasOwn(v,k));exact(v,['conversation','cursor','file_id',...optional]);
    const chat=authorized(v.conversation,'media');if(!validCursor(v.cursor)||!validFileId(v.file_id))fail(400,'invalid_media_reference');
    const title=v.title??'',tags=v.tags??[];if(typeof title!=='string'||[...title].length>80||title.includes('\0')||!Array.isArray(tags)||tags.length>8||tags.some(x=>typeof x!=='string'||!x.length||[...x].length>16||x.includes('\0'))||new Set(tags).size!==tags.length)fail(400,'invalid_favorite_metadata');
    // Only the explicitly selected retained media reference is fetched.
    const media=snapshot(await client.view_media({conversation:chat,cursor:v.cursor,file_id:v.file_id}));authorized(chat,'media');
    if(!same(media.conversation,chat)||media.cursor!==v.cursor||media.file_id!==v.file_id||!validMessageId(media.message_id))fail(502,'invalid_media_response');
    const base64=media.data_base64;if(typeof base64!=='string'||!base64.length||base64.length>4*Math.ceil(MEDIA_LIMITS.imageBytes/3)||base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))fail(400,'invalid_image');
    const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64)fail(400,'invalid_image');
    let meta;const decoding=Buffer.from(bytes);await validateImageBytes(decoding,media.mime,{decodeImage:async(b,m)=>{meta=await decodeImage(b,m);}});authorized(chat,'media');
    if(!decoding.equals(bytes)||meta?.format!==formats[media.mime]||![meta.width,meta.height,meta.frames].every(Number.isSafeInteger)||Math.min(meta.width,meta.height,meta.frames)<1||Math.max(meta.width,meta.height)>4096||meta.width*meta.height>12000000||meta.frames>60)fail(400,'invalid_image');
    const scope=scopeKey(chat),digest=sha(bytes),id='fv1:'+sha(scope+'\0'+media.mime+'\0'+digest),now=clock();
    db.exec('BEGIN IMMEDIATE');try{
      const old=db.prepare('SELECT * FROM tool_favorites WHERE id=?').get(id);
      if(db.prepare('SELECT 1 FROM tool_favorite_revocations WHERE scope=? AND message_id=?').get(scope,media.message_id))fail(403,'favorite_source_revoked');
      if(old?.state==='revoked')fail(403,'favorite_source_revoked');
      const n=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(length(bytes)),0) AS bytes FROM tool_favorites').get();
      if(!old&&(n.n>=200||n.bytes+bytes.length>64*1024*1024))fail(503,'capacity_exceeded');
      if(!old)db.prepare('INSERT INTO tool_favorites VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,scope,media.mime,digest,bytes,title,JSON.stringify(tags),JSON.stringify({...meta,animated:meta.frames>1}),now,'available');
      const origin=db.prepare('SELECT 1 FROM tool_favorite_origins WHERE favorite_id=? AND cursor=? AND message_id=? AND file_id=?').get(id,v.cursor,media.message_id,v.file_id);
      if(!origin&&db.prepare('SELECT COUNT(*) AS n FROM tool_favorite_origins WHERE favorite_id=?').get(id).n>=32)fail(503,'capacity_exceeded');
      db.prepare('INSERT OR IGNORE INTO tool_favorite_origins VALUES(?,?,?,?,?,?)').run(id,scope,v.cursor,media.message_id,v.file_id,now);
      db.exec('COMMIT');return metadata(rowFor(chat,id));
    }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
  }
  function list(input){const v=snapshot(input,{maxBytes:8192});exact(v,['conversation',...['query','after','limit'].filter(k=>Object.hasOwn(v,k))]);const chat=authorized(v.conversation),query=v.query??'',limit=v.limit??20,after=v.after??null;
    if(typeof query!=='string'||query.length>80||!Number.isSafeInteger(limit)||limit<1||limit>20||after!==null&&!favoriteId(after))fail(400,'invalid_request');
    // At most 200 records, literal substring search: SQL wildcards are inert.
    const q=query.toLocaleLowerCase('en-US'),all=db.prepare('SELECT * FROM tool_favorites WHERE scope=? ORDER BY id').all(scopeKey(chat)).filter(r=>(after===null||r.id>after)&&(r.title+' '+JSON.parse(r.tags).join(' ')).toLocaleLowerCase('en-US').includes(q)),page=all.slice(0,limit);
    return {conversation:chat,favorites:page.map(metadata),next:all.length>limit?page.at(-1).id:null,collection:'private_tool',live_recall_revocation:false};}
  function get(input){const v=snapshot(input);exact(v,['conversation','favorite_id']);const chat=authorized(v.conversation);return metadata(rowFor(chat,v.favorite_id));}
  function media(input){const v=snapshot(input);exact(v,['conversation','favorite_id']);const chat=authorized(v.conversation,'media'),row=rowFor(chat,v.favorite_id);return {...metadata(row),data_base64:verified(row).toString('base64')};}
  const delivery=row=>({request_id:row.request_id,state:row.state,...(row.message_id?{message_id:row.message_id}:{}),...(row.error?{error:row.error}:{})});
  async function send(input){const v=snapshot(input);exact(v,['conversation','favorite_id','request_id']);const chat=authorized(v.conversation,'send');if(!validRequestId(v.request_id))fail(400,'invalid_request');const row=rowFor(chat,v.favorite_id);const previous=db.prepare('SELECT * FROM tool_favorite_sends WHERE request_id=?').get(v.request_id);
    if(previous){if(previous.scope!==scopeKey(chat)||previous.favorite_id!==row.id)fail(409,'idempotency_conflict');return delivery(previous);}
    if(allowSend(chat)!==true)fail(403,'favorite_send_disabled');const bytes=verified(row);authorized(chat,'send');
    if(db.prepare('SELECT COUNT(*) AS n FROM tool_favorite_sends').get().n>=1000)fail(503,'capacity_exceeded');
    db.prepare('INSERT INTO tool_favorite_sends VALUES(?,?,?,\'unknown\',NULL,NULL)').run(v.request_id,row.id,scopeKey(chat));
    try{const result=validateDelivery(await client.send_message({conversation:chat,request_id:v.request_id,messages:[{type:'image',mime:row.mime,data_base64:bytes.toString('base64')}]}),v.request_id);db.prepare('UPDATE tool_favorite_sends SET state=?,message_id=?,error=? WHERE request_id=?').run(result.state,result.message_id??null,result.error??null,v.request_id);}catch{/* Keep unknown; never issue an automatic second send. */}
    return delivery(db.prepare('SELECT * FROM tool_favorite_sends WHERE request_id=?').get(v.request_id));}
  async function result(input){const v=snapshot(input);exact(v,['conversation','request_id']);const chat=authorized(v.conversation,'read_result');if(!validRequestId(v.request_id))fail(400,'invalid_request');const row=db.prepare('SELECT * FROM tool_favorite_sends WHERE request_id=? AND scope=?').get(v.request_id,scopeKey(chat));if(!row)return {request_id:v.request_id,state:'not_found'};
    if(row.state==='unknown'&&typeof client.get_send_result==='function'){const response=validateDelivery(await client.get_send_result(v),v.request_id,true);authorized(chat,'read_result');if(['sent','rejected'].includes(response.state))db.prepare('UPDATE tool_favorite_sends SET state=?,message_id=?,error=? WHERE request_id=?').run(response.state,response.message_id??null,response.error??null,v.request_id);}
    return delivery(db.prepare('SELECT * FROM tool_favorite_sends WHERE request_id=?').get(v.request_id));}
  // Trusted internal notice hook only. No route or QQ-text instruction handler.
  function revokeSource({conversation,message_id}){const chat=authorized(conversation);if(!validMessageId(message_id))fail(400,'invalid_request');const scope=scopeKey(chat);if(!db.prepare('SELECT 1 FROM tool_favorite_revocations WHERE scope=? AND message_id=?').get(scope,message_id)&&db.prepare('SELECT COUNT(*) AS n FROM tool_favorite_revocations').get().n>=1000)fail(503,'capacity_exceeded');db.prepare('INSERT OR IGNORE INTO tool_favorite_revocations VALUES(?,?)').run(scope,message_id);const ids=db.prepare('SELECT DISTINCT favorite_id FROM tool_favorite_origins WHERE scope=? AND message_id=?').all(scope,message_id);for(const {favorite_id} of ids)db.prepare("UPDATE tool_favorites SET bytes=NULL,state='revoked' WHERE id=?").run(favorite_id);return {revoked:ids.length,transport_live:false};}
  return Object.freeze({collect,list,search:list,get,media,send,result,revokeSource});
}
