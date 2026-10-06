import * as bridge from './chat_bridge.mjs';
import {createConversationFacade} from './send_facade.mjs';
import {createPrivateSendAdapter} from './conversation_tools.mjs';
import {createReplyEngine} from './reply_engine.mjs';
import {GroupSendScope} from './group_send_scope.mjs';
import {createGroupConversationAdapter,createGroupActionSender} from './group_conversation_adapter.mjs';
import {validateMessages} from './media_messages.mjs';
import {createConversationRouteHandlers} from './tool_routes.mjs';
import {createScopedReadRuntime,createScopedReplyResolver} from './scoped_read_runtime.mjs';
import {extendPrivateFacade} from './scoped_private_send.mjs';
export function createUnifiedToolRuntime({queue,source=null,adapter,mediaAdapter,decodeImage,engine,store=engine?.store,
  provider=adapter,groupActionCall=adapter?(action,payload)=>adapter.groupActionCall(action,payload):undefined,
  replyEnabled=true,selfId,timeoutMs=10000,backfill,errorFactory=(status,code)=>new bridge.Failure(status,code)}={}){
  const policy=queue.policy,resolveReply=backfill?input=>backfill.resolveReply(input):createScopedReplyResolver(queue);
  const quoteEngine=replyEnabled?createReplyEngine({bridge,store,adapter:createPrivateSendAdapter(adapter),validateMessages,decodeImage,
    resolveReply:async request=>{const ref=await resolveReply(request);return !!ref&&ref.expires_at>queue.now();}}):engine;
  const legacyPrivate=createConversationFacade({engine:quoteEngine,store,replyEnabled,imageEnabled:typeof decodeImage==='function',timeoutMs});
  const privateFacade=extendPrivateFacade({legacy:legacyPrivate,store,adapter,policy,decodeImage,resolveReply,timeoutMs,clock:()=>queue.now()});
  const groupScope=new GroupSendScope(store);
  const grouped=createGroupConversationAdapter({policy,groupScope,privateFacade,provider,validateMessages,decodeImage,resolveReply,
    sendGroup:groupActionCall?createGroupActionSender(groupActionCall):undefined,clock:()=>queue.now(),timeoutMs});
  const reads=createScopedReadRuntime({store:queue,historyStore:backfill?.store,source,mediaAdapter,decodeImage,sender:grouped,errorFactory,collectorOptions:{selfId}});
  const facade={...grouped,viewMedia:input=>reads.facade.viewMedia(input),async getChatInfo(input){
    const info=await grouped.getChatInfo(input);queue.authorize(input.conversation);
    return {...info,receive:{source:source?'scoped_history_poll':'unconfigured',complete:false,coverage:reads.store.sourceState(input.conversation)},
      capabilities:{...info.capabilities,view_media:typeof mediaAdapter?.readImage==='function'&&typeof decodeImage==='function'}};
  }};
  const handlers=Object.freeze({...createConversationRouteHandlers(facade,{errorFactory}),...reads.handlers,...(backfill?{'/qq/tools/read_history':async input=>{try{return await backfill.readHistory(input);}catch(e){if(Number.isInteger(e.status)&&typeof e.code==='string')throw errorFactory(e.status,e.code);throw e;}}}:{})});
  async function legacyEvents(input){
    if(!input||Object.keys(input).sort().join(',')!=='cursor,target'||input.target!==bridge.TARGET)throw errorFactory(403,'target_forbidden');
    const chat={type:'private',id:bridge.TARGET};
    const after=input.cursor===null?null:legacyCursor(input.cursor);
    const page=await reads.collector.pollEvents({conversation:chat,after,limit:20});
    // Preserve legacy decimal positions, private only. New tools always expose e1.
    const decimal=cursor=>String(queue.decodeCursor(chat,cursor));
    const messages=page.messages.filter(row=>row.direction==='incoming').map(row=>({cursor:decimal(row.cursor),conversation:row.conversation,
      user_id:row.user_id,message_id:row.message_id,time:row.time,messages:row.messages,received_at:row.received_at}));
    const output={cursor:decimal(page.cursor),messages,reset:page.reset,has_more:page.has_more};
    if(Buffer.byteLength(JSON.stringify(output))>380*1024)throw errorFactory(413,'events_response_too_large');return output;
  }
  const privateChat={type:'private',id:bridge.TARGET};
  function legacyCursor(value){
    if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>queue.high(privateChat))throw errorFactory(400,'invalid_cursor');
    return queue.cursor(privateChat,Number(value));
  }
  return Object.freeze({handlers,facade,reads,groupScope,legacyEvents,
    legacyMedia:input=>{
      if(!input||Object.keys(input).sort().join(',')!=='cursor,file_id,target'||input.target!==bridge.TARGET)throw errorFactory(403,'target_forbidden');
      return reads.facade.viewMedia({conversation:privateChat,cursor:legacyCursor(input.cursor),file_id:input.file_id}).then(({conversation,...value})=>({...value,cursor:input.cursor}));
    },
    confirmReply:input=>reads.confirmReply(input),close:()=>reads.close()});
}
