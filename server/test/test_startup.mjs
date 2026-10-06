import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../src/config.mjs';

async function fixture(t,wrong=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-startup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c=crypto.generateKeyPairSync('ed25519'),s=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root,'client-public.pem'),c.publicKey.export({format:'pem',type:'spki'}));
  fs.writeFileSync(path.join(root,'server-private.pem'),s.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  fs.writeFileSync(path.join(root,'token'),'T'.repeat(48),{mode:0o600});
  // A test-only executable mocks the existing container boundary. No Docker/QQ is used.
  fs.writeFileSync(path.join(root,'docker'),`#!/usr/bin/env python3
import sys,json,re
raw=sys.stdin.read();action=re.search(r'127[.]0[.]0[.]1:\\d+/([^"\\n]+)',raw).group(1)
if action=='get_login_info':data={'user_id':'${wrong?'12345':CONFIG.self_id}'}
elif action=='get_status':data={'online':True}
elif action in ('get_friend_msg_history','get_group_msg_history'):data={'messages':[]}
else:sys.exit(2)
print(json.dumps({'status':'ok','retcode':0,'data':data}))
`,{mode:0o700});
  const config={...CONFIG,listen_port:17445+Math.floor(Math.random()*30000),state_directory:'state',
    client_public_key_file:'client-public.pem',server_private_key_file:'server-private.pem',
    napcat:{...CONFIG.napcat,token_file:'token'},features:{actions:false,audio:false,notices:false}};
  const filename=path.join(root,'config.json');fs.writeFileSync(filename,JSON.stringify(config));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../main.mjs',import.meta.url))],{
    env:{...process.env,QQ_BRIDGE_CONFIG:filename,PATH:root+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  return {child,root};
}
test('full standalone server boots with synthetic account then shuts down',async t=>{
  const {child,root}=await fixture(t);
  const message=await new Promise((resolve,reject)=>{let error='';const timer=setTimeout(()=>reject(new Error('startup_timeout')),5000);
    child.stderr.on('data',d=>error+=d);child.stdout.once('data',d=>{clearTimeout(timer);resolve(JSON.parse(d));});
    child.once('exit',code=>{clearTimeout(timer);if(code)reject(new Error(error));});});
  assert.equal(message.listening,'127.0.0.1');
  assert.ok(fs.existsSync(path.join(root,'state','events.sqlite3')));
  child.kill('SIGTERM');await once(child,'exit');assert.equal(child.exitCode,0);
});
test('account mismatch prevents listener and persistent stores',async t=>{
  const {child,root}=await fixture(t,true);let stderr='';child.stderr.on('data',d=>stderr+=d);
  await once(child,'exit');assert.equal(child.exitCode,1);assert.match(stderr,/account_identity_mismatch/);
  assert.equal(fs.existsSync(path.join(root,'state','events.sqlite3')),false);
});
