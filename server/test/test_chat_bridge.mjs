import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Store,Engine,Failure,validateSend,parseCanonical,authenticate,requestCanonical,responseCanonical,signedResponse,sha,TARGET,CLIENT_ID,SEND_PATH,GROUPS,createGateway} from '../src/chat_bridge.mjs';

const payload=(text='stub text',id=crypto.randomUUID())=>({target:TARGET,request_id:id,messages:[{type:'text',text}]});
const body=value=>Buffer.from(JSON.stringify(value));
const rejection=(error,status,code)=>error instanceof Failure&&error.status===status&&(!code||error.code===code);
function headerList(key,value,nonce=crypto.randomBytes(32).toString('base64url'),timestamp=String(Date.now()),route=SEND_PATH){
 return ['X-Dot-Key-Id',CLIENT_ID,'X-Dot-Timestamp',timestamp,'X-Dot-Nonce',nonce,'X-Dot-Signature',crypto.sign(null,requestCanonical('POST',route,timestamp,nonce,value),key).toString('base64url')];
}
test('target and message schema are fixed; groups disabled',async()=>{
 assert.deepEqual(GROUPS,[]);
 for(const target of ['1',1000000001,'http://127.0.0.1/','1000000001;rm'])await assert.rejects(validateSend({...payload(),target}),e=>rejection(e,403));
 for(const messages of [[{type:'at',qq:'1'}],[{type:'text',text:'x',action:'send_group_msg'}],[{type:'image',url:'http://169.254.169.254/'}],[{type:'text',text:'\0'}]])await assert.rejects(validateSend({...payload(),messages}),e=>rejection(e,400));
});
test('bounded text, face, image bytes and no URLs/files',async()=>{
 await assert.rejects(validateSend(payload('x'.repeat(2001))),e=>rejection(e,413));
 const face={...payload(),messages:[{type:'face',id:14}]}; assert.equal((await validateSend(face)).messages[0].id,14);
 await assert.rejects(validateSend({...face,messages:[{type:'face',id:501}]}),e=>rejection(e,400));
 await assert.rejects(validateSend({...payload(),messages:[{type:'image',mime:'image/png',data_base64:'file:///etc/passwd'}]},()=>{}),e=>rejection(e,400));
 await assert.rejects(validateSend({...payload(),messages:[{type:'image',mime:'image/png',data_base64:Buffer.alloc(2097153).toString('base64')}]},()=>{}),e=>rejection(e,413));
 const image={...payload(),messages:[{type:'image',mime:'image/png',data_base64:Buffer.from('stub bytes').toString('base64')}]};
 await assert.rejects(validateSend(image),e=>rejection(e,503,'media_unavailable'));
 let validated=false;await validateSend(image,async(bytes,mime)=>{validated=true;assert.equal(mime,'image/png');assert.equal(bytes.toString(),'stub bytes');});assert.ok(validated);
});
test('duplicate JSON keys and noncanonical bodies rejected',()=>{
 assert.throws(()=>parseCanonical(Buffer.from('{"target":"1","target":"1000000001"}')),e=>rejection(e,400));
 assert.throws(()=>parseCanonical(Buffer.from('{ "x":1 }')),e=>rejection(e,400));
 assert.deepEqual(parseCanonical(body(payload() )).target,TARGET);
});
test('signed body tampering, wrong method/path, expired/duplicate headers rejected',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const store=new Store(':memory:');const value=body(payload());const headers=headerList(privateKey,value);
 assert.throws(()=>authenticate('POST',SEND_PATH,headers,body(payload('different')),publicKey,store),e=>rejection(e,401));
 assert.throws(()=>authenticate('GET',SEND_PATH,headers,value,publicKey,store),e=>rejection(e,405));
 assert.throws(()=>authenticate('POST',SEND_PATH+'?x=1',headers,value,publicKey,store),e=>rejection(e,404));
 assert.throws(()=>authenticate('POST',SEND_PATH,[...headers,'X-Dot-Key-Id',CLIENT_ID],value,publicKey,store),e=>rejection(e,401));
 const old=headerList(privateKey,value,crypto.randomBytes(32).toString('base64url'),String(Date.now()-31000));
 assert.throws(()=>authenticate('POST',SEND_PATH,old,value,publicKey,store),e=>rejection(e,401));
 authenticate('POST',SEND_PATH,headers,value,publicKey,store);
 assert.throws(()=>authenticate('POST',SEND_PATH,headers,value,publicKey,store),e=>rejection(e,409));store.close();
});
test('responses bind body, original nonce and status',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const auth={requestHash:'a'.repeat(64),nonce:crypto.randomBytes(32).toString('base64url')};
 const answer=signedResponse(auth,200,{message_id:'42'},privateKey);const timestamp=answer.headers['X-Dot-Response-Timestamp'];const signature=Buffer.from(answer.headers['X-Dot-Response-Signature'],'base64url');
 assert.ok(crypto.verify(null,responseCanonical(auth.requestHash,timestamp,auth.nonce,200,answer.body),publicKey,signature));
 assert.ok(!crypto.verify(null,responseCanonical(auth.requestHash,timestamp,auth.nonce,503,answer.body),publicKey,signature));
 assert.ok(!crypto.verify(null,responseCanonical(auth.requestHash,timestamp,'other',200,answer.body),publicKey,signature));
 assert.ok(!crypto.verify(null,responseCanonical(auth.requestHash,timestamp,auth.nonce,200,Buffer.from('{}')),publicKey,signature));
});
test('successful repeat returns same id without second upstream send',async()=>{
 const store=new Store(':memory:');let calls=0;const engine=new Engine(store,{send:async value=>{calls++;assert.equal(value.target,TARGET);return 42;}});const value=payload();
 assert.deepEqual(await engine.send(value),{request_id:value.request_id,message_id:'42'});
 assert.deepEqual(await engine.send(value),{request_id:value.request_id,message_id:'42'});assert.equal(calls,1);
 await assert.rejects(engine.send({...value,messages:[{type:'text',text:'different'}]}),e=>rejection(e,409,'idempotency_conflict'));assert.equal(calls,1);store.close();
});
test('uncertain transport is terminal for same id; no implicit retry',async()=>{
 const store=new Store(':memory:');let calls=0;const engine=new Engine(store,{send:async()=>{calls++;throw new Error('lost acknowledgement');}});const value=payload();
 await assert.rejects(engine.send(value),e=>rejection(e,503,'delivery_uncertain'));
 await assert.rejects(engine.send(value),e=>rejection(e,409,'delivery_uncertain'));assert.equal(calls,1);store.close();
});
test('concurrent same id has only one upstream attempt',async()=>{
 const store=new Store(':memory:');let calls=0;const engine=new Engine(store,{send:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return 42;}});const value=payload();
 const results=await Promise.allSettled(Array.from({length:12},()=>engine.send(value)));assert.equal(calls,1);assert.equal(results.filter(v=>v.status==='fulfilled').length,1);store.close();
});
test('nonce and uncertain id survive restart',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dot-chat-tests-'));const dbPath=path.join(directory,'state.sqlite3');const value=payload();const nonce=crypto.randomBytes(32).toString('base64url');
 let store=new Store(dbPath);store.nonce(nonce,Date.now());store.reserve(value);store.close();store=new Store(dbPath);
 assert.throws(()=>store.nonce(nonce,Date.now()),e=>rejection(e,409));let calls=0;const engine=new Engine(store,{send:async()=>{calls++;return 1;}});await assert.rejects(engine.send(value),e=>rejection(e,409,'delivery_uncertain'));assert.equal(calls,0);store.close();
 const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('dot-chat-tests-'));fs.rmSync(resolved,{recursive:true});
});
test('HTTP signed stub round trip and unsigned rejection',async()=>{
 const client=crypto.generateKeyPairSync('ed25519'),serverKeys=crypto.generateKeyPairSync('ed25519');const store=new Store(':memory:');const server=createGateway({publicKey:client.publicKey,privateKey:serverKeys.privateKey,store,backend:async value=>{await validateSend(value);return {request_id:value.request_id,message_id:'42'};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const request=(value,headers)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:SEND_PATH,method:'POST',headers:{'Content-Length':value.length,...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(value);});
 const value=body(payload());assert.equal((await request(value,{})).status,401);const list=headerList(client.privateKey,value);const headers={};for(let i=0;i<list.length;i+=2)headers[list[i]]=list[i+1];const result=await request(value,headers);assert.equal(result.status,200);
 const canonical=requestCanonical('POST',SEND_PATH,headers['X-Dot-Timestamp'],headers['X-Dot-Nonce'],value);
 assert.ok(crypto.verify(null,responseCanonical(sha(canonical),result.headers['x-dot-response-timestamp'],headers['X-Dot-Nonce'],200,result.body),serverKeys.publicKey,Buffer.from(result.headers['x-dot-response-signature'],'base64url')));
 assert.equal((await request(value,headers)).status,409);await new Promise(r=>server.close(r));store.close();
});
