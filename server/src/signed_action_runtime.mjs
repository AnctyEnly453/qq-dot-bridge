import {statePath} from './config.mjs';

import fs from 'node:fs';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {createFavoriteLibrary} from './favorite_library.mjs';
import {createNativeFavoriteTools} from './native_favorite_tools.mjs';
import {stageNativeFavorite,removeNativeFavorite} from './native_favorite_stage.mjs';
import {createTestMessageActions} from './message_actions.mjs';
import {createPeerReaction} from './peer_reaction.mjs';
import {createSignedActionHandlers} from './signed_action_routes.mjs';
import {snapshot,requireConversation,validMessageId,validAccountId} from './scoped_policy.mjs';
import {exact,fail} from './tool_contract.mjs';
import {createReactionReads} from './reaction_reads.mjs';
import {createScopedNoticeFeed} from './scoped_notice_feed.mjs';
import {ingestRecallNotice} from './message_actions.mjs';
import {createAudioSender} from './audio_sender.mjs';
import {createAudioProcessor} from './audio_processing.mjs';
import {createAudioTransport} from './audio_transport.mjs';
import {GroupSendScope} from './group_send_scope.mjs';

export function createSignedActionRuntime({policy,selfId,adapter,store,queue,facade,decodeImage,errorFactory,database=statePath('favorites.sqlite3'),enabled=false,audioEnabled=false,processAudio,stageAudio,removeAudio,sendAudio}={}){
 const db=new DatabaseSync(database);if(database!==':memory:')fs.chmodSync(database,0o600);db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000');
 const call=async(action,payload)=>{if(!['get_login_info','get_msg','get_emoji_likes','set_msg_emoji_like','delete_msg','fetch_custom_face_detail','add_custom_face'].includes(action))fail(403,'action_forbidden');return adapter._transport(action,payload,128*1024,{timeoutMs:8000});};
 const readMessage=async({conversation,message_id})=>{const chat=requireConversation(policy,conversation,'read_info');if(!validMessageId(message_id))fail(400,'invalid_message_id');const identity=await call('get_login_info',{});if(String(identity?.user_id)!==selfId)fail(403,'account_identity_mismatch');const raw=await call('get_msg',{message_id});requireConversation(policy,chat,'read_info');
  if(String(raw?.message_id)!==message_id||raw?.message_type!==chat.type||(chat.type==='group'?String(raw.group_id)!==chat.id:String(raw.peer_id??raw.target_id??raw.user_id??raw.sender?.user_id)!==chat.id))fail(403,'message_scope_forbidden');return raw;};
 const favorites=createFavoriteLibrary({db,policy,decodeImage,allowSend:()=>enabled,
  client:{view_media:v=>facade.viewMedia(v),send_message:v=>facade.sendMessage(v),get_send_result:v=>facade.getSendResult(v)}});
 const nativeFavorites=createNativeFavoriteTools({db,policy,selfId,exportFavorite:v=>favorites.media(v),call,stage:stageNativeFavorite,removeStaged:removeNativeFavorite,
  allowAdd:chat=>enabled&&chat.type==='group'});
 const tests=createTestMessageActions({store,policy,selfId,readMessage,call,allowMutations:enabled});
 const makeReaction=approvedTarget=>createPeerReaction({db,policy,selfId,readMessage,getIdentity:()=>call('get_login_info',{}),call,approvedTarget});
 const readonlyReactions=makeReaction(null);
 const reactions={result:readonlyReactions.result,async react(input){
  if(!enabled)fail(403,'peer_reaction_disabled');const v=snapshot(input);exact(v,['conversation','message_id','action_id','emoji_id']);
  const chat=requireConversation(policy,v.conversation,'send');if(chat.type!=='group'||v.emoji_id!=='14')fail(403,'peer_reaction_target_forbidden');
  const raw=await readMessage({conversation:chat,message_id:v.message_id}),author=String(raw?.sender?.user_id??raw?.user_id);
  if(!validAccountId(author)||author===selfId||!Array.isArray(raw.message))fail(403,'peer_message_provenance_failed');
  const text=raw.message.filter(p=>p.type==='text').map(p=>p.data?.text??'').join('');
  const grant={conversation:chat,message_id:v.message_id,author_id:author,text_sha256:crypto.createHash('sha256').update(text).digest('hex'),expires_at:Date.now()+60000};
  return makeReaction(grant).react(v);
 }};
 const readReactions=createReactionReads({policy,readMessage,call});
 const notices=createScopedNoticeFeed({db,policy,selfId,onRecall:({conversation,message_id,raw})=>{
   favorites.revokeSource({conversation,message_id});if(queue)ingestRecallNotice(queue,raw,{selfId});
 }});
 const transport=createAudioTransport({policy,adapter}),audioSender=createAudioSender({store,policy,groupScope:new GroupSendScope(store),selfId,enabled:audioEnabled,
  getIdentity:()=>call('get_login_info',{}),processAudio:processAudio??createAudioProcessor(),stage:stageAudio??transport.stage,removeStaged:removeAudio??transport.removeStaged,sendAudio:sendAudio??transport.sendAudio});
 return Object.freeze({handlers:createSignedActionHandlers({favorites,nativeFavorites,tests,reactions,readReactions,notices,audioSender,errorFactory}),favorites,tests,readReactions,notices,audioSender,close:()=>db.close()});
}
