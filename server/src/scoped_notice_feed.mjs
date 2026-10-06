import crypto from 'node:crypto';import {snapshot,requireConversation,scopeKey,validAccountId,validMessageId} from './scoped_policy.mjs';import {exact,fail} from './tool_contract.mjs';
export function createScopedNoticeFeed({db,policy,selfId,onRecall=()=>{},clock=Date.now}={}){
 db.exec('CREATE TABLE IF NOT EXISTS tool_scoped_notices(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,fingerprint TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL)');let connected=false;
 function acceptNotice(input){try{
  const v=snapshot(input,{maxBytes:2048});if(v.post_type!=='notice'||v.self_id!==selfId||!['group_recall','friend_recall','group_msg_emoji_like'].includes(v.notice_type))return false;
  const group=v.notice_type!=='friend_recall',reaction=v.notice_type==='group_msg_emoji_like';
  exact(v,['post_type','notice_type','self_id','user_id','message_id','time',...(group?['group_id']:[]),...(Object.hasOwn(v,'operator_id')?['operator_id']:[]),...(reaction?['likes','is_add']:[])]);
  if(!validAccountId(v.user_id)||!validMessageId(v.message_id)||!Number.isSafeInteger(v.time)||v.time<0||v.time*1000>clock()+30000||v.operator_id!==undefined&&!validAccountId(v.operator_id))return false;
  const conversation=requireConversation(policy,{type:group?'group':'private',id:group?v.group_id:v.user_id},'read_info');
  if(reaction&&(typeof v.is_add!=='boolean'||!Array.isArray(v.likes)||v.likes.length<1||v.likes.length>5||v.likes.some(x=>Object.keys(x).sort().join(',')!=='count,emoji_id'||typeof x.emoji_id!=='string'||!/^\d{1,10}$/.test(x.emoji_id)||!Number.isInteger(x.count)||x.count<0||x.count>1000000)))return false;
  const actor=reaction?v.user_id:v.operator_id??null,author=reaction?null:group?v.user_id:null;
  const notice={conversation,event_type:reaction?'reaction':'recall',message_id:v.message_id,time:v.time,actor_user_id:actor,message_author_user_id:author,
   ...(reaction?{likes:v.likes,is_add:v.is_add,count_semantics:'notice_value'}:{withdrawal_kind:actor&&author?(actor===author?'author_recalled':'operator_recalled'):'operator_unknown'}),source:'native_ws_notice'};
  const payload=JSON.stringify(notice),fingerprint=crypto.createHash('sha256').update(payload).digest('hex');
  const added=db.prepare('INSERT OR IGNORE INTO tool_scoped_notices(scope,fingerprint,payload,received_at) VALUES(?,?,?,?)').run(scopeKey(conversation),fingerprint,payload,clock());
  db.exec('DELETE FROM tool_scoped_notices WHERE seq NOT IN(SELECT seq FROM tool_scoped_notices ORDER BY seq DESC LIMIT 1000)');
  if(!reaction)onRecall({conversation,message_id:v.message_id,raw:v});return !!added.changes;
 }catch{return false;}}
 function poll(input){const v=snapshot(input,{maxBytes:4096});exact(v,['conversation',...['after','limit'].filter(k=>Object.hasOwn(v,k))]);const conversation=requireConversation(policy,v.conversation,'read_info'),scope=scopeKey(conversation),limit=v.limit??20,after=v.after??null;
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail(400,'invalid_request');const prefix='n1:'+scope+':';let pos=0;
  if(after!==null){if(typeof after!=='string'||!after.startsWith(prefix)||!/^\d{1,15}$/.test(after.slice(prefix.length)))fail(400,'cursor_scope_mismatch');pos=Number(after.slice(prefix.length));}
  const bounds=db.prepare('SELECT MIN(seq) AS low,MAX(seq) AS high FROM tool_scoped_notices WHERE scope=?').get(scope),high=bounds.high??0;
  if(pos>high)fail(400,'cursor_out_of_range');const reset=pos>0&&bounds.low!==null&&pos<bounds.low-1;
  const rows=db.prepare('SELECT seq,payload FROM tool_scoped_notices WHERE scope=? AND seq>? ORDER BY seq LIMIT ?').all(scope,pos,limit+1),page=rows.slice(0,limit);
  return {conversation,notices:page.map(r=>({...JSON.parse(r.payload),cursor:prefix+r.seq})),cursor:prefix+(page.at(-1)?.seq??pos),reset,has_more:rows.length>limit,transport_live:connected,complete:false};
 }
 return Object.freeze({acceptNotice,poll,connected:()=>{connected=true;},disconnected:()=>{connected=false;}});
}
