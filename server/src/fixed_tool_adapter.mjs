import {TARGET,sha} from './chat_bridge.mjs';
import {NapCatTransport} from './napcat_transport.mjs';
import {compactStringify} from './wire_json.mjs';
import {UpstreamSendFailure} from './send_failures.mjs';
import {createConversationPolicy,requireConversation,validAccountId} from './scoped_conversation_policy.mjs';
import {ToolFailure} from './tool_contract.mjs';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
const reject=()=>{throw new ToolFailure(400,'invalid_request');};
// QQ-only actions; transport and credentials stay on the server.
export class FixedToolAdapter extends NapCatTransport {
  constructor(tokenPath,{policy=createConversationPolicy(),jpegStager=null}={}){super(tokenPath);this.policy=policy;this.jpegStager=jpegStager;}
  async call(action,payload,maxBuffer){
    if(action==='get_image')return super.call(action,payload,maxBuffer);
    if(action==='send_private_msg'){
      if(!exact(payload,['user_id','message','auto_escape'])||payload.auto_escape!==true||!Array.isArray(payload.message)||payload.message.length<1||payload.message.length>8)reject();
      requireConversation(this.policy,{type:'private',id:id(payload.user_id)},'send');
      for(const segment of payload.message){
        if(!exact(segment,['type','data']))reject();const data=segment.data;
        if(segment.type==='text'){if(!exact(data,['text'])||typeof data.text!=='string'||!data.text||data.text.includes('\0')||[...data.text].length>2000)reject();}
        else if(segment.type==='face'){if(!exact(data,['id'])||typeof data.id!=='string'||!/^\d{1,3}$/.test(data.id)||Number(data.id)>500)reject();}
        else if(segment.type==='reply'){if(!exact(data,['id'])||typeof data.id!=='string'||!/^-?[0-9]{1,20}$/.test(data.id))reject();}
        else if(segment.type==='image'){if(!exact(data,['file'])||typeof data.file!=='string'||!data.file.startsWith('base64://')||data.file.length>3*1024*1024)reject();}
        else reject();
      }
      return this.sendTransport(action,payload,payload.message.some(s=>s?.type==='image')?45000:8000);
    }
    if(action==='get_msg'){
      if(!exact(payload,['conversation','message_id'])||typeof payload.message_id!=='string'||!/^-?[0-9]{1,20}$/.test(payload.message_id))reject();
      requireConversation(this.policy,payload.conversation,'read_info');
      return this._transport(action,{message_id:payload.message_id},384*1024);
    }
    if(action==='get_group_msg_history'){
      if(!exact(payload,['group_id','message_seq','count','reverseOrder'])||!validAccountId(id(payload.group_id))||payload.message_seq!==0||payload.count!==20||payload.reverseOrder!==true)reject();
      requireConversation(this.policy,{type:'group',id:id(payload.group_id)},'read_info');
      return this._transport(action,payload,384*1024);
    }
    if(action==='get_friend_msg_history'){
      if(!exact(payload,['user_id','message_seq','count','reverseOrder'])||payload.count!==20||payload.reverseOrder!==true||!(payload.message_seq===0||typeof payload.message_seq==='string'&&/^-?[0-9]{1,20}$/.test(payload.message_seq)))reject();
      requireConversation(this.policy,{type:'private',id:id(payload.user_id)},'read_info');
      return this._transport(action,payload,384*1024);
    }
    if(action==='get_stranger_info'){
      if(!exact(payload,['user_id','no_cache'])||payload.no_cache!==true)reject();
      requireConversation(this.policy,{type:'private',id:id(payload.user_id)},'read_info');
    }else if(action==='get_group_info'){
      if(!exact(payload,['group_id','no_cache'])||!validAccountId(id(payload.group_id))||payload.no_cache!==true)reject();
      requireConversation(this.policy,{type:'group',id:id(payload.group_id)},'read_info');
    }else if(action==='get_group_member_info'){
      if(!exact(payload,['group_id','user_id','no_cache'])||!validAccountId(id(payload.group_id))||!validAccountId(id(payload.user_id))||payload.no_cache!==true)reject();
      requireConversation(this.policy,{type:'group',id:id(payload.group_id)},'read_info');
    }else if(action==='send_group_msg'){
      if(!exact(payload,['group_id','message','auto_escape'])||!validAccountId(id(payload.group_id))||payload.auto_escape!==true||!Array.isArray(payload.message)||payload.message.length<1||payload.message.length>8)reject();
      requireConversation(this.policy,{type:'group',id:id(payload.group_id)},'send');
      // This boundary receives only canonical OneBot segments produced by the guarded facade.
      for(const segment of payload.message){
        if(!exact(segment,['type','data']))reject();const data=segment.data;
        if(segment.type==='text'){if(!exact(data,['text'])||typeof data.text!=='string'||!data.text||data.text.includes('\0')||[...data.text].length>2000)reject();}
        else if(segment.type==='face'){if(!exact(data,['id'])||typeof data.id!=='string'||!/^\d{1,3}$/.test(data.id)||Number(data.id)>500)reject();}
        else if(segment.type==='at'){if(!exact(data,['qq'])||!validAccountId(data.qq))reject();requireConversation(this.policy,{type:'group',id:id(payload.group_id)},'mention');}
        else if(segment.type==='reply'){if(!exact(data,['id'])||typeof data.id!=='string'||!/^-?[0-9]{1,20}$/.test(data.id))reject();requireConversation(this.policy,{type:'group',id:id(payload.group_id)},'reply');}
        else if(segment.type==='image'){if(!exact(data,['file'])||typeof data.file!=='string'||!data.file.startsWith('base64://')||data.file.length>3*1024*1024)reject();}
        else reject();
      }
    }else throw new ToolFailure(403,'action_forbidden');
    // Fixed read/send result budgets; caller cannot enlarge them.
    return action==='send_group_msg'?this.sendTransport(action,payload,payload.message.some(s=>s.type==='image')?45000:8000):this._transport(action,payload,16384);
  }
  async sendTransport(action,payload,timeoutMs){
    if(!this.jpegStager)return this._transport(action,payload,16384,{timeoutMs});
    const original=JSON.parse(compactStringify(payload)),copy=JSON.parse(compactStringify(original)),logicalPayloadHash=sha(compactStringify(original)),paths=[],started=Date.now();let nativeStarted=false;
    try{for(const part of copy.message){if(part.type!=='image')continue;const bytes=Buffer.from(part.data.file.slice(9),'base64');if(bytes.subarray(0,3).toString('hex')!=='ffd8ff')continue;
      const path=await this.jpegStager.stage(bytes);if(typeof path!=='string'||!/^\/tmp\/dot-jpeg-send\/[a-f0-9-]{36}-[a-f0-9]{64}\.jpg$/.test(path))throw Object.assign(Error(),{code:'jpeg_stage_unavailable'});paths.push(path);part.data.file=path;
    }
    requireConversation(this.policy,{type:action==='send_group_msg'?'group':'private',id:String(action==='send_group_msg'?copy.group_id:copy.user_id)},'send');nativeStarted=true;
    const answer=await this._transport(action,copy,16384,{timeoutMs,logicalPayloadHash});
    if(/^-?[0-9]{1,20}$/.test(String(answer?.message_id)))for(const path of paths)try{await this.jpegStager.remove(path);}catch{}
    return answer;
    }catch(e){if(!nativeStarted){const reason=e?.code==='jpeg_stage_full'?'jpeg_stage_full':e?.code==='conversation_forbidden'?'conversation_forbidden':'jpeg_stage_unavailable',failure={retcode:null,reason,cause_codes:[reason],definitive_pre_send:true};
      try{this.onTransportOutcome?.({at:started,action,elapsed_ms:Date.now()-started,payload_bytes:Buffer.byteLength(compactStringify(original)),payload_hash:logicalPayloadHash,state:'local_staging_rejected',retcode:null,message_id:null,failure});}catch{}
      for(const path of paths)try{await this.jpegStager.remove(path);}catch{}throw new UpstreamSendFailure(failure);
    }if(e instanceof UpstreamSendFailure&&e.definitivePreSend)for(const path of paths)try{await this.jpegStager.remove(path);}catch{}throw e;}
  }
  async privateHistory({before=null,userId=TARGET}={}){
    const result=await this.call('get_friend_msg_history',{user_id:Number(userId),message_seq:before===null?0:before,count:20,reverseOrder:true});
    if(!Array.isArray(result?.messages)||result.messages.length>20)throw new ToolFailure(503,'invalid_history');
    return result.messages;
  }
  // Preserve the original fixed latest-window history interface for existing internal callers.
  history(payload){
    if(JSON.stringify(payload)!==JSON.stringify({user_id:Number(TARGET),message_seq:0,count:20}))reject();
    return this.privateHistory();
  }
  getPrivateInfo({user_id}){requireConversation(this.policy,{type:'private',id:user_id},'read_info');return this.call('get_stranger_info',{user_id:Number(user_id),no_cache:true});}
  getGroupInfo({group_id}){return this.call('get_group_info',{group_id,no_cache:true});}
  getGroupMemberInfo({group_id,user_id}){return this.call('get_group_member_info',{group_id,user_id,no_cache:true});}
  groupActionCall(action,payload){if(action!=='send_group_msg')throw new ToolFailure(403,'action_forbidden');return this.call(action,payload);}
  async readLatest({conversation,limit}){
    const chat=requireConversation(this.policy,conversation,'read_info');if(limit!==20)reject();
    if(chat.type==='private')return this.privateHistory({userId:chat.id});
    const result=await this.call('get_group_msg_history',{group_id:chat.id,message_seq:0,count:20,reverseOrder:true});
    if(!Array.isArray(result?.messages)||result.messages.length>20)throw new ToolFailure(503,'invalid_history');
    requireConversation(this.policy,chat,'read_info');return result.messages;
  }
  async getScopedMessage({conversation,message_id}){
    const chat=requireConversation(this.policy,conversation,'read_info');
    const raw=await this.call('get_msg',{conversation:chat,message_id});requireConversation(this.policy,chat,'read_info');
    if(!raw||id(raw.message_id)!==message_id||raw.message_type!==chat.type||
      (chat.type==='group'?id(raw.group_id)!==chat.id:id(raw.user_id??raw.sender?.user_id)!==chat.id))throw new ToolFailure(503,'media_provenance_unavailable');
    return raw;
  }
  async readOlderGroupPage({conversation,before,limit=20}){
    const chat=requireConversation(this.policy,conversation,'read_info');
    if(chat.type!=='group')throw new ToolFailure(403,'backfill_scope_forbidden');
    if(limit!==20||typeof before!=='string'||!/^-?[0-9]{1,20}$/.test(before))reject();
    const result=await this._transport('get_group_msg_history',{group_id:chat.id,message_seq:before,count:20,reverseOrder:true},384*1024,{timeoutMs:3500});
    requireConversation(this.policy,chat,'read_info');
    if(!Array.isArray(result?.messages)||result.messages.length>20)throw new ToolFailure(503,'invalid_history');
    return result.messages;
  }
}
