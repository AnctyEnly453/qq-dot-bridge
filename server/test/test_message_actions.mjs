import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {Store} from '../src/chat_bridge.mjs';
import {GroupSendScope,groupBodyHash} from '../src/group_send_scope.mjs';
import {createScopedConversationPolicy} from '../src/scoped_policy.mjs';
import {createTestMessageActions} from '../src/message_actions.mjs';
import {PRIVATE_ID} from './fixtures.mjs';

const group = {type:'group', id:'1000000003'};
function fixture(t, {readMessage, call} = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const scope = new GroupSendScope(store), request_id = crypto.randomUUID();
  const payload={conversation:group,request_id,messages:[{type:'text',text:'offline fixture'}]};
  let now = 1000000;
  const calls = [];
  const api = createTestMessageActions({store, allowMutations:true, policy:createScopedConversationPolicy({allowedGroups:[group.id]}), selfId:PRIVATE_ID,
    clock:() => now,
    readMessage:async () => { if (readMessage) await readMessage(value => { now = value; }); return {message_id:'123',message_type:'group',group_id:group.id,sender:{user_id:PRIVATE_ID}}; },
    call:async (...args) => { calls.push(args); return call ? call(...args) : null; }});
  api.declareTestSend({conversation:group,request_id,purpose:'self_test',body_hash:groupBodyHash(payload)});
  scope.reserve(payload);scope.complete(request_id,'123');
  api.registerTestSend({conversation:group, request_id, purpose:'self_test'});
  return {api,store,calls,request_id};
}
const reaction = f => ({conversation:group, request_id:f.request_id, action_id:crypto.randomUUID(), emoji_id:'128', set:true});

test('reordered reaction and conversation keys preserve semantic idempotency', async t => {
  const f = fixture(t), input = reaction(f);
  await f.api.react(input);
  const reordered = {set:true,emoji_id:'128',action_id:input.action_id,request_id:input.request_id,conversation:{id:group.id,type:'group'}};
  assert.equal((await f.api.react(reordered)).state,'api_acknowledged');
  assert.equal(f.calls.length,1);
  await assert.rejects(f.api.react({...reordered,set:false}), {code:'idempotency_conflict'});
});
test('clock rollback during asynchronous provenance lookup cannot grant action authority', async t => {
  const f = fixture(t,{readMessage:async setNow => setNow(999999)});
  await assert.rejects(f.api.react(reaction(f)),{code:'test_message_forbidden'});
  assert.equal(f.calls.length,0);
});
test('non-object action and registration requests fail with structured errors', async t => {
  const f = fixture(t);
  for (const value of [null,true,1,'x',[]]) {
    await assert.rejects(f.api.react(value), {code:'invalid_request',status:400});
    assert.throws(() => f.api.registerTestSend(value), {code:'invalid_test_registration',status:400});
  }
});
test('concurrent reordered reactions reserve once even when transport is uncertain', async t => {
  const f = fixture(t,{call:async () => {throw Error('offline uncertain fixture');}}), input = reaction(f);
  const reordered = {set:input.set,emoji_id:input.emoji_id,action_id:input.action_id,request_id:input.request_id,conversation:{id:group.id,type:group.type}};
  const results = await Promise.all([f.api.react(input),f.api.react(reordered)]);
  assert.equal(f.calls.length,1);
  assert.deepEqual(results.map(v=>v.state),['unknown','unknown']);
  assert.equal((await f.api.react(reordered)).state,'unknown');
  assert.equal(f.calls.length,1);
});
test('legacy stored action hashes keep exact-body replay compatibility', async t => {
  const f = fixture(t), input = reaction(f);
  const hash = crypto.createHash('sha256').update(JSON.stringify({kind:'reaction',...input})).digest('hex');
  f.store.db.prepare('INSERT INTO tool_message_actions_v2 VALUES(?,?,?,?,?)').run(input.action_id,hash,'group:'+group.id,input.request_id,'unknown');
  assert.equal((await f.api.react(input)).state,'unknown');
  assert.equal(f.calls.length,0);
});
test('expired and invalid clock after provenance lookup fail closed', async t => {
  for(const now of [1120001,NaN,Infinity]) {
    const f = fixture(t,{readMessage:async setNow=>setNow(now)});
    await assert.rejects(f.api.react(reaction(f)),{code:'test_message_forbidden'});
    assert.equal(f.calls.length,0);
  }
});
test('emoji identifiers remain strings and reject coercion or unknown fields', async t => {
  const f = fixture(t), input = reaction(f);
  for(const value of [128,-1,'-1','',null,true,'128x','12345678901']) {
    await assert.rejects(f.api.react({...input,emoji_id:value}),{code:'invalid_request'});
  }
  await assert.rejects(f.api.react({...input,set:'true'}),{code:'invalid_request'});
  await assert.rejects(f.api.react({...input,message_id:'123'}),{code:'invalid_request'});
  assert.equal(f.calls.length,0);
});
