import test from 'node:test';
import assert from 'node:assert/strict';
import {ScopedEventStore} from '../src/scoped_events.mjs';
import {createScopedConversationPolicy} from '../src/scoped_policy.mjs';
import {BoundedGroupBackfill} from '../src/bounded_group_backfill.mjs';
import {createScopedReadRuntime} from '../src/scoped_read_runtime.mjs';
const NOW=1790932000000,A={type:'group',id:'1000000003'},P={type:'private',id:'1000000001'},B={type:'group',id:'10001'};
const raw=(id,time=NOW/1000-100)=>({post_type:'message',message_type:'group',group_id:A.id,user_id:'3001',sender:{user_id:'3001'},self_id:'999',message_id:String(id),time,message:[{type:'text',data:{text:'mock '+id}},{type:'image',data:{file:'backfill.png'}},...(id===8?[{type:'reply',data:{id:'9'}}]:[])]});
function setup(t,{rows,latest,read}={}){
  const policy=createScopedConversationPolicy({allowedGroups:[A.id,B.id]}),queue=new ScopedEventStore(':memory:',{policy,clock:()=>NOW});t.after(()=>queue.close());
  const all=rows??Array.from({length:65},(_,i)=>raw(900-i,NOW/1000-200+i));
  const live=latest??all.slice(-20);for(const row of live)queue.ingest(row);
  let calls=0;
  const adapter={readOlderGroupPage:async input=>{calls++;if(read)return read(input);const index=all.findIndex(row=>row.message_id===input.before);if(index<0)throw new Error('missing anchor');return all.slice(Math.max(0,index-19),index+1);}};
  const backfill=new BoundedGroupBackfill(queue,adapter);backfill.observeNativeLive(A,live);
  return {queue,backfill,calls:()=>calls,all};
}
test('bounded older recovery beyond20 is history-only, preserves real poll high/read/inbox and exposes usable e1',async t=>{
  const f=setup(t);f.queue.openConsumer(A,'default');f.queue.readIntoInbox(A,'default');const before=f.queue.getState({conversation:A}),high=f.queue.high(A);
  const oldest=f.all.at(-20).message_id,result=await f.backfill.readHistory({conversation:A,before:oldest,limit:20});
  assert.equal(result.backfill.pages,2);assert.equal(result.backfill.added_rows,38);assert.equal(result.messages.length,20);assert.ok(result.messages.every(row=>row.time<f.all.at(-20).time));
  assert.equal(f.queue.high(A),high);assert.deepEqual(f.queue.getState({conversation:A}),before);assert.equal(f.queue.page(A,'0',20).messages.length,20);
  const record=result.messages[0];assert.ok(record.cursor.startsWith('e1.'));assert.equal(f.backfill.store.getRetainedMessage({conversation:A,cursor:record.cursor}).message_id,record.message_id);
  assert.throws(()=>f.queue.decodeCursor(A,record.cursor),e=>e.code==='invalid_cursor');assert.throws(()=>f.backfill.store.getRetainedMessage({conversation:B,cursor:record.cursor}),e=>e.code==='cursor_conversation_mismatch');
});
test('same-second descending IDs retain native ordering across inclusive boundaries and latest live edges',async t=>{
  const all=Array.from({length:65},(_,i)=>raw(900-i));const f=setup(t,{rows:all});
  const first=await f.backfill.readHistory({conversation:A,before:'855',limit:20});
  assert.deepEqual(first.messages.map(row=>row.message_id),Array.from({length:20},(_,i)=>String(875-i)));
  const snapshot=f.backfill.history.readHistory({conversation:A,limit:50});assert.deepEqual(snapshot.messages.slice(-20).map(row=>row.message_id),all.slice(-20).map(row=>row.message_id));
  const earlier=await f.backfill.readHistory({conversation:A,before:first.messages[0].message_id,limit:20});assert.equal(earlier.backfill.incomplete,true);
  assert.deepEqual(earlier.messages.map(row=>row.message_id),Array.from({length:20},(_,i)=>String(895-i)));
});
test('repeat cache read is idempotent, bounded budgets and missing/stalled upstream remain explicit',async t=>{
  const f=setup(t);await f.backfill.readHistory({conversation:A,before:'855',limit:20});const count=f.calls();
  await f.backfill.readHistory({conversation:A,before:'855',limit:20});assert.equal(f.calls(),count);
  await assert.rejects(f.backfill.readHistory({conversation:A,backfill_pages:3}),e=>e.code==='invalid_backfill_budget');assert.equal(f.calls(),count);
  const disabled=await f.backfill.readHistory({conversation:A,before:'893',backfill_pages:0});assert.equal(disabled.backfill.reason,'disabled');
  const noSource=setup(t,{read:async()=>{throw new Error('no history');}});const failure=await noSource.backfill.readHistory({conversation:A,before:'855'});assert.equal(failure.backfill.reason,'upstream_unavailable');assert.equal(failure.coverage.upstream_complete,false);
});
test('concurrent realtime arrival enters only realtime inbox; coalesced backfill never doubles cache',async t=>{
  let release;const all=Array.from({length:25},(_,i)=>raw(100-i,NOW/1000-200+i));
  const f=setup(t,{rows:all,latest:all.slice(-5),read:input=>new Promise(resolve=>release=()=>resolve(all.slice(0,21)))});
  // Use a valid anchored20 page, not an oversized fixture.
  f.backfill.adapter.readOlderGroupPage=()=>new Promise(resolve=>release=()=>resolve(all.slice(1,21)));
  f.queue.openConsumer(A,'default');f.queue.readIntoInbox(A,'default');const original=f.queue.high(A);
  const pending=f.backfill.readHistory({conversation:A,before:'80',backfill_pages:1}),second=f.backfill.readHistory({conversation:A,before:'80',backfill_pages:1});
  f.queue.ingest(raw(999,NOW/1000));release();const [a,b]=await Promise.all([pending,second]);
  assert.equal(a.backfill.added_rows,19);assert.equal(b.backfill.coalesced,true);assert.equal(f.queue.high(A),original+1);
  const inbox=f.queue.readIntoInbox(A,'default');assert.deepEqual(inbox.messages.map(row=>row.message_id),['999']);
  assert.equal(f.queue.db.prepare('SELECT COUNT(*) AS n FROM sr_history_cache').get().n,19);
});
test('old image/reply remain scoped and fully decoded; recall denies both without inbox records',async t=>{
  const rows=[9,8,7,6,5].map((id,index)=>raw(id,NOW/1000-50+index));const f=setup(t,{rows,latest:rows.slice(-2)});
  const page=await f.backfill.readHistory({conversation:A,before:'6',backfill_pages:1});const row=page.messages.find(row=>row.message_id==='8');assert.ok(row);
  const ref=f.backfill.store.resolveReply({conversation:A,cursor:row.cursor,message_id:'8'});assert.equal(ref.message_id,'8');
  let decoded=0,transport=0;
  const reads=createScopedReadRuntime({store:f.backfill.store,mediaAdapter:{readImage:async request=>{transport++;assert.equal(request.conversation.id,A.id);assert.equal(request.message_id,'8');return Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63fcff1f0003030200efa53d990000000049454e44ae426082','hex');}},decodeImage:async()=>{decoded++;}});
  assert.equal((await reads.facade.viewMedia({conversation:A,cursor:row.cursor,file_id:'backfill.png'})).message_id,'8');assert.equal(decoded,1);
  const chain=reads.facade.getMessage({conversation:A,message_id:'8'});assert.equal((await chain).message.reference.message_id,'9');
  f.queue.ingest({post_type:'notice',notice_type:'group_recall',group_id:A.id,user_id:'3001',message_id:'8',time:NOW/1000});
  assert.equal(f.backfill.store.resolveReply({conversation:A,cursor:row.cursor,message_id:'8'}),null);
  await assert.rejects(reads.facade.viewMedia({conversation:A,cursor:row.cursor,file_id:'backfill.png'}),e=>e.code==='media_not_found');assert.equal(transport,1);
});
test('private chats and authorized groups without retained anchors never initiate backfill',async t=>{
  const f=setup(t);for(const conversation of [P,B]){const result=await f.backfill.readHistory({conversation});assert.equal(result.backfill.reason,conversation.type==='private'?'scope_not_enabled':'no_retained_anchor');}assert.equal(f.calls(),0);
});
test('unsupported historical content is reported without blocking supported older records or entering realtime log',async t=>{
  const rows=[1,2,3,4,5,6,7].map(id=>raw(id));rows[4]={...rows[4],message:[{type:'record',data:{file:'inert-unsupported'}}]};
  const f=setup(t,{rows,latest:rows.slice(-2)}),page=await f.backfill.readHistory({conversation:A,before:'6',backfill_pages:1});
  assert.equal(page.backfill.unrepresentable_rows,1);assert.deepEqual(page.messages.map(row=>row.message_id),['1','2','3','4']);
  assert.equal(f.queue.historySnapshot(A).records.length,2);assert.equal(page.backfill.incomplete,true);
});
