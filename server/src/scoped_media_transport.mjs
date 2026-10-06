import {EventFailure,requireConversation,validFileId,scopeKey} from './scoped_policy.mjs';
// Carries entire retained provenance to fixed upstream get_msg, verifies actual peer/image,
// and fails closed on cache filename ambiguity. Never delegates to legacy readImage(fileId).
export function createScopedMediaTransport({store,adapter}={}){
  if(typeof store?.getRetainedMessage!=='function'||typeof adapter?.getScopedMessage!=='function'||typeof adapter?.readCacheImage!=='function')throw new TypeError('scoped store and fixed adapter required');
  return Object.freeze({async readImage(request){
    const {conversation,cursor,message_id,file_id}=request??{};
    const chat=requireConversation(store.policy,conversation,'media');
    if(!validFileId(file_id))throw new EventFailure(400,'invalid_media_reference');
    const check=()=>{
      const row=store.getRetainedMessage({conversation:chat,cursor});
      if(row.message_id!==message_id||row.state!=='available'||!row.messages.some(segment=>segment.type==='image'&&segment.file_id===file_id))throw new EventFailure(404,'media_not_found');
      const matches=store.db.prepare("SELECT DISTINCT log.scope FROM sr_log AS log,json_each(json_extract(log.payload,'$.messages')) AS segment WHERE log.event_type='message' AND log.expires>? AND json_extract(segment.value,'$.type')='image' AND json_extract(segment.value,'$.file_id')=? LIMIT 2").all(store.now(),file_id);
      if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sr_history_cache'").get())for(const row of store.db.prepare("SELECT DISTINCT log.scope FROM sr_history_cache AS log,json_each(json_extract(log.payload,'$.messages')) AS segment WHERE log.expires>? AND json_extract(segment.value,'$.type')='image' AND json_extract(segment.value,'$.file_id')=? LIMIT 2").all(store.now(),file_id))if(!matches.some(m=>m.scope===row.scope))matches.push(row);
      if(matches.length!==1||matches[0].scope!==scopeKey(chat))throw new EventFailure(503,'media_provenance_ambiguous');
    };
    check();const raw=await adapter.getScopedMessage({conversation:chat,message_id});check();
    if(!Array.isArray(raw.message)||!raw.message.some(segment=>segment?.type==='image'&&segment.data?.file===file_id))throw new EventFailure(503,'media_provenance_unavailable');
    const info=await adapter.call('get_image',{file_id},16384);check();
    if(typeof info?.file!=='string')throw new EventFailure(503,'media_unavailable');
    const bytes=await adapter.readCacheImage(info.file,file_id);check();return bytes;
  }});
}
