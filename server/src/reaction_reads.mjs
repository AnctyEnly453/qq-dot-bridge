import {snapshot,requireConversation,validMessageId,validAccountId} from './scoped_policy.mjs';
import {exact,fail} from './tool_contract.mjs';
const account=value=>typeof value==='string'?value:Number.isSafeInteger(value)&&value>0?String(value):null;
// Installed get_emoji_likes accepts count>0 and retrieves at most one native
// page for count=10. Never use its count=0 (up to 200 pages) default.
export function createReactionReads({policy,readMessage,call}={}){
 if(typeof readMessage!=='function'||typeof call!=='function')throw TypeError('trusted reaction read dependencies required');
 return async input=>{
  const v=snapshot(input,{maxBytes:8192});exact(v,['conversation','message_id','emoji_ids']);const chat=requireConversation(policy,v.conversation,'read_info');
  if(chat.type!=='group'||!validMessageId(v.message_id)||!Array.isArray(v.emoji_ids)||v.emoji_ids.length<1||v.emoji_ids.length>5||new Set(v.emoji_ids).size!==v.emoji_ids.length||v.emoji_ids.some(x=>typeof x!=='string'||!/^\d{1,10}$/.test(x)))fail(400,'invalid_reaction_query');
  await readMessage({conversation:chat,message_id:v.message_id});requireConversation(policy,chat,'read_info');const reactions=[];
  for(const emoji_id of v.emoji_ids){
   const raw=snapshot(await call('get_emoji_likes',{message_id:v.message_id,group_id:chat.id,emoji_id,count:10}),{maxBytes:32768,maxNodes:500,maxArray:15,maxDepth:6});requireConversation(policy,chat,'read_info');
   if(!Array.isArray(raw?.emoji_like_list)||raw.emoji_like_list.length>10||raw.emoji_like_list.some(x=>!validAccountId(account(x?.user_id))))fail(502,'invalid_reaction_response');
   const users=[...new Set(raw.emoji_like_list.map(x=>account(x.user_id)))];
   reactions.push({emoji_id,user_ids:users,observed_users:users.length,complete:false,max_users:10});
  }
  return {conversation:chat,message_id:v.message_id,reactions,source:'native_http_read',live_event:false};
 };
}
