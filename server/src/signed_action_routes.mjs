import {ToolFailure} from './tool_contract.mjs';

// Fixed signed endpoints only. Every operation still validates its own exact
// schema, conversation scope, provenance and durable mutation identifier.
export const ACTION_TOOL_ROUTES=Object.freeze({
  collect_favorite:'/qq/tools/collect_favorite',
  list_favorites:'/qq/tools/list_favorites',
  get_favorite:'/qq/tools/get_favorite',
  send_favorite:'/qq/tools/send_favorite',
  get_favorite_send_result:'/qq/tools/get_favorite_send_result',
  add_qq_favorite:'/qq/tools/add_qq_favorite',
  get_qq_favorite_result:'/qq/tools/get_qq_favorite_result',
  verify_qq_favorite:'/qq/tools/verify_qq_favorite',
  declare_test_send:'/qq/tools/declare_test_send',
  register_test_send:'/qq/tools/register_test_send',
  recall_test_message:'/qq/tools/recall_test_message',
  get_message_action_result:'/qq/tools/get_message_action_result',
  react_message:'/qq/tools/react_message',
  get_reaction_result:'/qq/tools/get_reaction_result',
  read_reactions:'/qq/tools/read_reactions',
  poll_notices:'/qq/tools/poll_notices',
  send_audio:'/qq/tools/send_audio',
});
export const ACTION_TOOL_PATHS=Object.freeze(Object.values(ACTION_TOOL_ROUTES));
export function createSignedActionHandlers({favorites,nativeFavorites,tests,reactions,readReactions,notices,audioSender,errorFactory=(s,c)=>new ToolFailure(s,c)}={}){
  const operations={collect_favorite:()=>favorites?.collect,list_favorites:()=>favorites?.list,get_favorite:()=>favorites?.get,
    send_favorite:()=>favorites?.send,get_favorite_send_result:()=>favorites?.result,
    add_qq_favorite:()=>nativeFavorites?.add,get_qq_favorite_result:()=>nativeFavorites?.result,verify_qq_favorite:()=>nativeFavorites?.verify,
    declare_test_send:()=>tests?.declareTestSend,register_test_send:()=>tests?.registerTestSend,recall_test_message:()=>tests?.recall,
    get_message_action_result:()=>tests?.result,react_message:()=>reactions?.react,get_reaction_result:()=>reactions?.result,read_reactions:()=>readReactions,poll_notices:()=>notices?.poll,send_audio:()=>audioSender?.send};
  return Object.freeze(Object.fromEntries(Object.entries(ACTION_TOOL_ROUTES).map(([name,path])=>[path,async input=>{
    const operation=operations[name]();if(typeof operation!=='function')throw errorFactory(503,'action_tool_unconfigured');
    try{return await operation(input);}catch(e){if(e instanceof ToolFailure||Number.isInteger(e?.status)&&e.status>=400&&e.status<=599&&typeof e.code==='string'&&/^[a-z_]{1,64}$/.test(e.code))throw errorFactory(e.status,e.code);throw e;}
  }])));
}
