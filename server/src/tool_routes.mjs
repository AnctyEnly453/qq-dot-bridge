import {ToolFailure} from './tool_contract.mjs';
const POLL_EVENTS_PATH='/qq/tools/poll_events';
import {ACTION_TOOL_PATHS} from './signed_action_routes.mjs';
// Public route allowlist. Fixed routes do not expose arbitrary actions or destinations.
export const HISTORY_TOOL_ROUTES=Object.freeze({
  '/qq/tools/read_history':'readHistory',
  '/qq/tools/search_history':'searchHistory',
  '/qq/tools/get_message':'getMessage',
});
export const HISTORY_TOOL_PATHS=Object.freeze(Object.keys(HISTORY_TOOL_ROUTES));
export const CONVERSATION_TOOL_ROUTES=Object.freeze({
  '/qq/tools/get_chat_info':'getChatInfo',
  '/qq/tools/send_message':'sendMessage',
  '/qq/tools/get_send_result':'getSendResult',
  '/qq/tools/view_media':'viewMedia',
});
export const CONVERSATION_TOOL_PATHS=Object.freeze(Object.keys(CONVERSATION_TOOL_ROUTES));
export const ALL_TOOL_PATHS=Object.freeze([...HISTORY_TOOL_PATHS,...CONVERSATION_TOOL_PATHS,POLL_EVENTS_PATH,...ACTION_TOOL_PATHS]);
export function createHistoryRouteHandlers(history){
  return Object.freeze(Object.fromEntries(Object.entries(HISTORY_TOOL_ROUTES).map(([path,name])=>{
    if(typeof history?.[name]!=='function')throw new TypeError('missing history tool');
    return [path,input=>history[name](input)];
  })));
}
export function createConversationRouteHandlers(facade,{errorFactory=(status,code)=>new ToolFailure(status,code)}={}){
  return Object.freeze(Object.fromEntries(Object.entries(CONVERSATION_TOOL_ROUTES).map(([path,name])=>{
    if(typeof facade?.[name]!=='function')throw new TypeError('missing conversation tool');
    return [path,async input=>{
      try{return await facade[name](input);}
      catch(error){if(error instanceof ToolFailure)throw errorFactory(error.status,error.code);throw error;}
    }];
  })));
}
