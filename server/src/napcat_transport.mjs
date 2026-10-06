import crypto from 'node:crypto';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {CONFIG,sourcePath,PRIMARY_PRIVATE as TARGET} from './config.mjs';
import {compactStringify} from './wire_json.mjs';
import {validFileId} from './private_media.mjs';
import {Failure,sha} from './chat_bridge.mjs';
import {describeSendFailure,UpstreamSendFailure} from './send_failures.mjs';
export class NapCatTransport {
  constructor(tokenPath){this.tokenPath=tokenPath;}
  async history(payload){
    const fixed={user_id:Number(TARGET),message_seq:0,count:20};
    if(compactStringify(payload)!==compactStringify(fixed))throw new Error('invalid history payload');
    const data=await this.call('get_friend_msg_history',fixed,384*1024);
    if(!Array.isArray(data?.messages))throw new Error('history unavailable');
    return data.messages;
  }
  async readImage(fileId){
    if(!validFileId(fileId))throw new Failure(400,'invalid_media_reference');
    const info=await this.call('get_image',{file_id:fileId},16384);
    if(typeof info?.file!=='string')throw new Failure(503,'media_unavailable');
    return this.readCacheImage(info.file,fileId);
  }
  async readCacheImage(filePath,fileId){
    if(typeof filePath!=='string'||!validFileId(fileId))throw new Failure(503,'media_unavailable');
    return new Promise((resolve,reject)=>{
      const child=execFile(CONFIG.python,['-I',sourcePath('cache_image_reader.py'),CONFIG.napcat.cache_mount,CONFIG.napcat.cache_container_path],{encoding:'buffer',timeout:5000,maxBuffer:2*1024*1024+1},(error,stdout)=>{
        if(error){const large=error.code===3||error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER';reject(new Failure(large?413:503,large?'message_too_large':'media_unavailable'));}
        else resolve(stdout);
      });
      child.stdin.on('error',()=>{});child.stdin.end(compactStringify({path:filePath,file_id:fileId}));
    });
  }
  async send(value){
    const message=value.messages.map(item=>item.type==='text'?{type:'text',data:{text:item.text}}:item.type==='face'?{type:'face',data:{id:String(item.id)}}:{type:'image',data:{file:'base64://'+item.data_base64}});
    const payload={user_id:Number(TARGET),message,auto_escape:true};
    const data=await this.call('send_private_msg',payload,16384);
    return data?.message_id;
  }
  async call(action,payload,maxBuffer){
    if(!['send_private_msg','get_friend_msg_history','get_image'].includes(action))throw new Error('action forbidden');
    return this._transport(action,payload,maxBuffer);
  }
  async _transport(action,payload,maxBuffer,{timeoutMs=8000,logicalPayloadHash=null}={}){
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>(['send_private_msg','send_group_msg'].includes(action)?45000:8000))throw new Error('invalid internal timeout');
    if(logicalPayloadHash!==null&&!/^[a-f0-9]{64}$/.test(logicalPayloadHash))throw new Error('invalid internal payload binding');
    if(action!=='get_login_info'){
      const identity=await this._transport('get_login_info',{},16384);
      if(String(identity?.user_id)!==CONFIG.self_id)throw new Failure(503,'account_identity_mismatch');
    }
    const token=fs.readFileSync(this.tokenPath,'utf8').trim();
    if(! /^[A-Za-z0-9_-]{40,100}$/.test(token))throw new Error('credential unavailable');
    const config='url = "http://127.0.0.1:'+CONFIG.napcat.http_port+'/'+action+'"\nrequest = "POST"\nheader = "Authorization: Bearer '+token+'"\nheader = "Content-Type: application/json"\ndata = '+compactStringify(compactStringify(payload))+'\n';
    const payloadText=compactStringify(payload),started=Date.now();
    const record=(state,retcode=null,messageId=null,failure=null)=>{if(!['send_private_msg','send_group_msg'].includes(action)||typeof this.onTransportOutcome!=='function')return;try{this.onTransportOutcome({at:started,action,elapsed_ms:Date.now()-started,payload_bytes:Buffer.byteLength(payloadText),payload_hash:logicalPayloadHash??sha(payloadText),state,retcode,message_id:typeof messageId==='number'&&Number.isSafeInteger(messageId)||typeof messageId==='string'&&/^-?[0-9]{1,20}$/.test(messageId)?String(messageId):null,...(failure?{failure}:{})});}catch{/* Diagnostic failure cannot retry/cancel a send. */}};
    let output;try{output=await new Promise((resolve,reject)=>{
      const child=execFile('docker',['exec','-i',CONFIG.napcat.container,'curl','--silent','--show-error','--max-time',String(timeoutMs/1000),'--config','-'],{timeout:timeoutMs+2000,maxBuffer},(error,stdout)=>error?reject(new Error('transport unavailable')):resolve(stdout));
      child.stdin.on('error',()=>{});child.stdin.end(config);
    });}catch(e){record('transport_unavailable');throw e;}
    let parsed;try{parsed=JSON.parse(output);}catch{record('invalid_json');throw new Error('acknowledgement unavailable');}
    if(parsed.status!=='ok'||parsed.retcode!==0){const failure=describeSendFailure(parsed);record('upstream_rejected',failure.retcode,null,failure);throw new UpstreamSendFailure(failure);}
    record('ack',0,parsed.data?.message_id);
    return parsed.data;
  }
}
