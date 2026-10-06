import {CONFIG} from './config.mjs';
import {PRIMARY_PRIVATE} from './config.mjs';
import {compactStringify,parseCompact} from './wire_json.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {describeSendFailure,UpstreamSendFailure,rejectedDelivery} from './send_failures.mjs';
const EVENTS_PATH='/qq/private/events';
const MEDIA_PATH='/qq/private/media';
import {ALL_TOOL_PATHS} from './tool_routes.mjs';

export const TARGET=PRIMARY_PRIVATE;
export const GROUPS=Object.freeze([]);
export const CLIENT_ID=CONFIG.client_key_id;
export const SERVER_ID=CONFIG.server_key_id;
export const AUDIENCE=CONFIG.audience;
export const SEND_PATH='/qq/private/send';
export const MAX_BODY=3*1024*1024;
const isAuthenticatedPath=path=>path==='/qq/status'||path===SEND_PATH||path===EVENTS_PATH||path===MEDIA_PATH||ALL_TOOL_PATHS.includes(path);
export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export class Failure extends Error { constructor(status,code){super(code);this.status=status;this.code=code;} }
const fail=(status,code)=>{throw new Failure(status,code);};
export function keys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...expected].sort().join(',')) fail(400,'invalid_request');
}
export function parseCanonical(body){try{return parseCompact(body);}catch{fail(400,'invalid_request');}}
export async function validateSend(value,imageValidator){
  keys(value,['target','request_id','messages']);
  if(!TARGET||value.target!==TARGET) fail(403,'target_forbidden');
  if(typeof value.request_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.request_id)) fail(400,'invalid_request');
  if(!Array.isArray(value.messages)||value.messages.length<1||value.messages.length>8) fail(400,'invalid_request');
  const messages=[];let textCount=0,imageCount=0;
  for(const item of value.messages){
    if(item?.type==='text'){
      keys(item,['type','text']);
      if(typeof item.text!=='string'||!item.text.length||item.text.includes('\0')) fail(400,'invalid_request');
      textCount += [...item.text].length;
      if(textCount>2000) fail(413,'message_too_large');
      messages.push({type:'text',text:item.text});
    }else if(item?.type==='face'){
      keys(item,['type','id']);
      if(!Number.isInteger(item.id)||item.id<0||item.id>500) fail(400,'invalid_request');
      messages.push({type:'face',id:item.id});
    }else if(item?.type==='image'){
      keys(item,['type','mime','data_base64']);
      if(++imageCount>1) fail(413,'message_too_large');
      if(!['image/png','image/jpeg','image/gif','image/webp'].includes(item.mime)||typeof item.data_base64!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(item.data_base64)) fail(400,'invalid_image');
      const decoded=Buffer.from(item.data_base64,'base64');
      if(decoded.toString('base64')!==item.data_base64||!decoded.length) fail(400,'invalid_image');
      if(decoded.length>2*1024*1024) fail(413,'message_too_large');
      if(!imageValidator) fail(503,'media_unavailable');
      await imageValidator(decoded,item.mime);
      messages.push({type:'image',mime:item.mime,data_base64:item.data_base64});
    }else fail(400,'invalid_request');
  }
  return {target:TARGET,request_id:value.request_id,messages};
}
export function requestCanonical(method,path,timestamp,nonce,body){
  return Buffer.from([path==='/qq/status'?'napcat-status-request-v1':'napcat-chat-request-v1',AUDIENCE,CLIENT_ID,method,path,timestamp,nonce,sha(body),''].join('\n'));
}
export function responseCanonical(requestHash,timestamp,nonce,status,body,protocol='chat'){
  return Buffer.from(['napcat-'+protocol+'-response-v1',AUDIENCE,SERVER_ID,requestHash,timestamp,nonce,String(status),sha(body),''].join('\n'));
}
export function b64url(value,size){
  if(typeof value!=='string'||! /^[A-Za-z0-9_-]+$/.test(value)) fail(401,'unauthorized');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==size||bytes.toString('base64url')!==value) fail(401,'unauthorized');
  return bytes;
}
export class Store {
  constructor(path){
    this.db=new DatabaseSync(path,{timeout:5000});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS used_nonce(key_id TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(key_id,nonce)); CREATE TABLE IF NOT EXISTS sends(request_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT);');
    if(path!==':memory:')fs.chmodSync(path,0o600);
  }
  close(){this.db.close();}
  nonce(nonce,now){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('DELETE FROM used_nonce WHERE expires < ?').run(now);
      this.db.prepare('INSERT INTO used_nonce VALUES(?,?,?)').run(CLIENT_ID,nonce,now+120000);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');if(error.code==='ERR_SQLITE_ERROR'&&error.message.includes('UNIQUE'))fail(409,'replay');throw error;}
  }
  reserve(value){
    const hash=sha(compactStringify(value));
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const existing=this.db.prepare('SELECT * FROM sends WHERE request_id=?').get(value.request_id);
      if(existing){
        this.db.exec('COMMIT');
        if(existing.body_hash!==hash)fail(409,'idempotency_conflict');
        if(rejectedDelivery(this,value.request_id,hash))fail(409,'delivery_rejected');
        if(existing.state!=='complete')fail(409,'delivery_uncertain');
        return existing.message_id;
      }
      if(this.db.prepare('SELECT COUNT(*) AS count FROM sends').get().count>=100000){this.db.exec('COMMIT');fail(503,'capacity_exceeded');}
      this.db.prepare("INSERT INTO sends VALUES(?,?,'pending',NULL)").run(value.request_id,hash);
      this.db.exec('COMMIT');return null;
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  complete(id,messageId){this.db.prepare("UPDATE sends SET state='complete',message_id=? WHERE request_id=? AND state='pending'").run(messageId,id);}
  reject(id,error){if(!(error instanceof UpstreamSendFailure)||!error.definitivePreSend)return false;
    const row=this.db.prepare('SELECT body_hash,state FROM sends WHERE request_id=?').get(id);if(!row||row.state!=='pending')return false;
    this.db.exec('CREATE TABLE IF NOT EXISTS tool_send_rejections(request_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,error_code TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO tool_send_rejections VALUES(?,?,?)').run(id,row.body_hash,'upstream_pre_send_rejected');return true;
  }
}
export function authenticate(method,path,rawHeaders,body,publicKey,store,now=Date.now()){
  if(!isAuthenticatedPath(path)) fail(404,'not_found');
  if(method!==(path==='/qq/status'?'GET':'POST')) fail(405,'method_not_allowed');
  const one=name=>{
    const matches=[];for(let i=0;i<rawHeaders.length;i+=2)if(rawHeaders[i].toLowerCase()===name)matches.push(rawHeaders[i+1]);
    if(matches.length!==1)fail(401,'unauthorized');return matches[0];
  };
  if(one('x-dot-key-id')!==CLIENT_ID)fail(401,'unauthorized');
  const timestamp=one('x-dot-timestamp'),nonce=one('x-dot-nonce'),signature=one('x-dot-signature');
  if(! /^[0-9]{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>30000)fail(401,'unauthorized');
  b64url(nonce,32);const signed=b64url(signature,64);
  const canonical=requestCanonical(method,path,timestamp,nonce,body);
  if(!crypto.verify(null,canonical,publicKey,signed))fail(401,'unauthorized');
  store.nonce(nonce,now);
  return {requestHash:sha(canonical),nonce,...(path==='/qq/status'?{protocol:'status'}:{})};
}
export function signedResponse(auth,status,value,key){
  const body=value===null?Buffer.alloc(0):Buffer.from(compactStringify(value));const timestamp=String(Date.now());
  return {status,body,headers:{'X-Dot-Server-Key-Id':SERVER_ID,'X-Dot-Response-Timestamp':timestamp,'X-Dot-Request-Hash':auth.requestHash,'X-Dot-Response-Signature':crypto.sign(null,responseCanonical(auth.requestHash,timestamp,auth.nonce,status,body,auth.protocol),key).toString('base64url')}};
}
export class Engine {
  constructor(store,adapter,imageValidator){this.store=store;this.adapter=adapter;this.imageValidator=imageValidator;}
  async send(input){
    const value=await validateSend(input,this.imageValidator);
    const previous=this.store.reserve(value);
    if(previous!==null)return {request_id:value.request_id,message_id:previous};
    try{
      const id=await this.adapter.send(value);
      const messageId=String(id);
      if(! /^-?[0-9]{1,20}$/.test(messageId)||(typeof id==='number'&&!Number.isSafeInteger(id)))throw new Error('acknowledgement unavailable');
      this.store.complete(value.request_id,messageId);
      return {request_id:value.request_id,message_id:messageId};
    }catch(error){if(this.store.reject(value.request_id,error))fail(503,'upstream_pre_send_rejected');fail(503,'delivery_uncertain');}
  }
}
export async function readBody(request){
  if(request.headers['transfer-encoding'])fail(400,'invalid_request');
  const contentLength=request.headers['content-length'];
  if(!contentLength||! /^[0-9]+$/.test(contentLength)||Number(contentLength)>MAX_BODY)fail(413,'request_too_large');
  let length=0;const chunks=[];
  for await(const chunk of request){length+=chunk.length;if(length>MAX_BODY)fail(413,'request_too_large');chunks.push(chunk);}
  if(length!==Number(contentLength))fail(400,'invalid_request');
  return Buffer.concat(chunks);
}
function respond(response,status,body,extra={}){
  response.writeHead(status,{'Content-Type':'application/json','Content-Length':body.length,'Cache-Control':'no-store','Connection':'close',...extra});response.end(body);
}
export function createGateway({publicKey,privateKey,store,backend,events,media,status,tools={}}){
  return http.createServer({maxHeaderSize:4096,requestTimeout:5000,headersTimeout:5000},async(request,response)=>{
    let auth;
    try{
      if(!isAuthenticatedPath(request.url))fail(404,'not_found');
      const isStatus=request.url==='/qq/status';
      if(request.method!==(isStatus?'GET':'POST'))fail(405,'method_not_allowed');
      if(isStatus&&(request.headers['transfer-encoding']||request.headers['content-length']&&request.headers['content-length']!=='0'))fail(400,'invalid_request');
      const body=isStatus?Buffer.alloc(0):await readBody(request);
      auth=authenticate(request.method,request.url,request.rawHeaders,body,publicKey,store);
      const value=isStatus?{}:parseCanonical(body);
      const handler=isStatus?status:request.url===SEND_PATH?backend:request.url===EVENTS_PATH?events:request.url===MEDIA_PATH?media:tools[request.url];
      if(typeof handler!=='function')fail(503,ALL_TOOL_PATHS.includes(request.url)?'tool_unavailable':'receive_unavailable');
      const result=await handler(value);
      const answer=signedResponse(auth,200,result,privateKey);respond(response,answer.status,answer.body,answer.headers);
    }catch(error){
      const status=error instanceof Failure?error.status:503;const code=error instanceof Failure?error.code:'unavailable';
      if(auth){const answer=signedResponse(auth,status,{error:code},privateKey);respond(response,answer.status,answer.body,answer.headers);}
      else respond(response,status,Buffer.alloc(0));
    }
  });
}
