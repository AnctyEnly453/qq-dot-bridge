import {PRIVATE_TARGET, snapshot, validateSendShape, validateResultRequest, validMessageId, delivery, fail, boundedWait} from './tool_contract.mjs';
import {requireConversation,validAccountId} from './scoped_policy.mjs';
import {validateMessages} from './media_messages.mjs';
import {rejectedDelivery} from './send_failures.mjs';

// Existing legacy facade and Store remain authoritative. Only the explicitly
// approved additional peer is handled here; metadata prevents cross-peer lookup.
export function extendPrivateFacade({legacy,store,adapter,policy,decodeImage,resolveReply,timeoutMs=10000,clock=Date.now}) {
  const db=store.db;
  db.exec('CREATE TABLE IF NOT EXISTS tool_private_send_scope(request_id TEXT PRIMARY KEY,peer_id TEXT NOT NULL,body_hash TEXT NOT NULL)');
  const owner=id=>db.prepare('SELECT peer_id,body_hash FROM tool_private_send_scope WHERE request_id=?').get(id);
  return Object.freeze({...legacy,
    getChatInfo(input) {
      const chat=requireConversation(policy,input?.conversation,'read_info');
      return {...legacy.getChatInfo({...input,conversation:{type:'private',id:PRIVATE_TARGET}}),conversation:chat};
    },
    async sendMessage(input) {
      const captured=snapshot(input),chat=requireConversation(policy,captured.conversation,'send');
      const bound=owner(captured.request_id);
      if(chat.id===PRIVATE_TARGET){if(bound)fail(409,'idempotency_conflict');return legacy.sendMessage(captured);}
      const shape=validateSendShape({...captured,conversation:{type:'private',id:PRIVATE_TARGET}});
      const value={target:chat.id,request_id:shape.request_id,messages:shape.messages};
      const attempt=Promise.resolve().then(async()=>{
        const row=db.prepare('SELECT body_hash FROM sends WHERE request_id=?').get(value.request_id);
        if(row){const current=owner(value.request_id);if(!current||current.peer_id!==chat.id)fail(409,'idempotency_conflict');const id=store.reserve(value);return delivery(value.request_id,'sent',id);}
        const base=await validateMessages(value.messages.filter(s=>s.type!=='reply'),{decodeImage});let index=0;
        const messages=value.messages.map(s=>s.type==='reply'?s:base[index++]);
        const quote=messages.find(s=>s.type==='reply');
        let quoteExpiresAt=null;
        if(quote){
          requireConversation(policy,chat,'reply');
          if(typeof resolveReply!=='function')fail(503,'reply_unavailable');
          let ref;try{ref=await resolveReply({conversation:chat,cursor:quote.cursor,message_id:quote.message_id});}catch{fail(503,'reply_unavailable');}
          requireConversation(policy,chat,'reply');
          if(!ref||ref.conversation?.type!=='private'||ref.conversation.id!==chat.id||ref.cursor!==quote.cursor||ref.message_id!==quote.message_id||!validAccountId(ref.user_id)||!Number.isSafeInteger(ref.expires_at)||ref.expires_at<=clock())fail(404,'reply_not_found');
          quoteExpiresAt=ref.expires_at;
        }
        requireConversation(policy,chat,'send');
        const normalized={...value,messages};
        db.exec('BEGIN IMMEDIATE');try{
          const prior=owner(value.request_id);if(prior&&prior.peer_id!==chat.id)fail(409,'idempotency_conflict');
          if(!prior){if(db.prepare('SELECT request_id FROM sends WHERE request_id=?').get(value.request_id))fail(409,'idempotency_conflict');if(db.prepare('SELECT COUNT(*) AS n FROM tool_private_send_scope').get().n>=100000)fail(503,'capacity_exceeded');db.prepare('INSERT INTO tool_private_send_scope VALUES(?,?,?)').run(value.request_id,chat.id,'');}
          db.exec('COMMIT');
        }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
        const previous=store.reserve(normalized);if(previous!==null)return delivery(value.request_id,'sent',previous);
        db.prepare('UPDATE tool_private_send_scope SET body_hash=(SELECT body_hash FROM sends WHERE request_id=?) WHERE request_id=?').run(value.request_id,value.request_id);
        requireConversation(policy,chat,'send');
        if(quoteExpiresAt!==null&&quoteExpiresAt<=clock())return delivery(value.request_id,'unknown');
        try {
          const message=messages.map(s=>s.type==='text'?{type:'text',data:{text:s.text}}:s.type==='face'?{type:'face',data:{id:String(s.id)}}:s.type==='reply'?{type:'reply',data:{id:s.message_id}}:{type:'image',data:{file:'base64://'+s.data_base64}});
          const result=await adapter.call('send_private_msg',{user_id:Number(chat.id),message,auto_escape:true},16384),id=result?.message_id;
          if((typeof id!=='string'&&typeof id!=='number')||(typeof id==='number'&&!Number.isSafeInteger(id))||!validMessageId(String(id)))throw Error('invalid ack');
          store.complete(value.request_id,String(id));return delivery(value.request_id,'sent',String(id));
        }catch(e){if(store.reject?.(value.request_id,e))return rejectedDelivery(store,value.request_id,db.prepare('SELECT body_hash FROM sends WHERE request_id=?').get(value.request_id).body_hash);return delivery(value.request_id,'unknown');}
      }).catch(e=>{if(e.code==='delivery_rejected')return rejectedDelivery(store,value.request_id,db.prepare('SELECT body_hash FROM sends WHERE request_id=?').get(value.request_id).body_hash);if(e.code==='delivery_uncertain')return delivery(value.request_id,'unknown');throw e;});
      return boundedWait(attempt,timeoutMs,()=>delivery(value.request_id,'unknown'));
    },
    getSendResult(input) {
      const chat=requireConversation(policy,input?.conversation,'read_result');
      const value=validateResultRequest({...input,conversation:{type:'private',id:PRIVATE_TARGET}}),bound=owner(value.request_id);
      if(chat.id===PRIVATE_TARGET)return bound?delivery(value.request_id,'not_found'):legacy.getSendResult(input);
      if(!bound||bound.peer_id!==chat.id)return delivery(value.request_id,'not_found');
      const row=db.prepare('SELECT body_hash,state,message_id FROM sends WHERE request_id=?').get(value.request_id);
      if(!row)return delivery(value.request_id,'not_found');
      if(value.body_hash&&value.body_hash!==row.body_hash)fail(409,'idempotency_conflict');
      if(row.state!=='complete'){const rejected=rejectedDelivery(store,value.request_id,row.body_hash);if(rejected)return rejected;}
      return row.state==='complete'&&validMessageId(row.message_id)?delivery(value.request_id,'sent',row.message_id):delivery(value.request_id,'unknown');
    }
  });
}
