import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGateway,Store,AUDIENCE,CLIENT_ID,SERVER_ID} from '../src/chat_bridge.mjs';
import {validateConfig,CONFIG} from '../src/config.mjs';

test('deployment requires explicit HTTPS, account and allowlist',()=>{
  assert.throws(()=>validateConfig({...CONFIG,self_id:''}),/account/);
  assert.throws(()=>validateConfig({...CONFIG,allowed_privates:[],allowed_groups:[]}),/allowlist/);
  assert.throws(()=>validateConfig({...CONFIG,audience:'http://localhost'}),/https/);
  assert.throws(()=>validateConfig({...CONFIG,audience:'https://example.invalid/bot'}),/https/);
  assert.throws(()=>validateConfig({...CONFIG,napcat:{...CONFIG.napcat,container:'bad; shell'}}),/napcat/);
  assert.doesNotThrow(()=>validateConfig({...CONFIG,allowed_privates:['12345'],allowed_groups:['67890']}));
});

test('Python client verifies real Node status and tool signatures over offline loopback',async t=>{
  const c=crypto.generateKeyPairSync('ed25519'),s=crypto.generateKeyPairSync('ed25519');
  const store=new Store(':memory:');t.after(()=>store.close());
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-wire-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const server=createGateway({publicKey:c.publicKey,privateKey:s.privateKey,store,
    status:async()=>({online:true}),tools:{'/qq/tools/get_chat_info':async()=>({name:'synthetic fixture'})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const fixture={port:server.address().port,temporary_directory:temporary,
    private:c.privateKey.export({format:'pem',type:'pkcs8'}),config:{schema_version:1,server_url:AUDIENCE,client_key_id:CLIENT_ID,
      private_key_file:'unused.pem',server_key_id:SERVER_ID,server_public_key_raw_base64:Buffer.from(s.publicKey.export({format:'jwk'}).x,'base64url').toString('base64'),
      expected_qq_id:'1000000004',account_binding_confirmed:true,require_https_proxy:true,timeout_seconds:5,state_directory:'state'}};
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('python3',[fileURLToPath(new URL('./wire_client.py',import.meta.url))],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
    child.on('error',reject);child.on('close',code=>code?reject(new Error(stderr)):resolve(JSON.parse(stdout)));child.stdin.end(JSON.stringify(fixture));
  });
  assert.deepEqual(result,{status_verified:true,tool_verified:true});
  assert.deepEqual(fs.readdirSync(temporary),[]);
});
