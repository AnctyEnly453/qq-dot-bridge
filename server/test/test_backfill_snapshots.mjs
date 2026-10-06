import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ScopedEventStore} from '../src/scoped_events.mjs';
import {createScopedConversationPolicy} from '../src/scoped_policy.mjs';
import {BoundedGroupBackfill} from '../src/bounded_group_backfill.mjs';
import {createScopedHistoryTools} from '../src/scoped_history.mjs';
const NOW=1790932000000,C={type:'group',id:'1000000003'},P={type:'private',id:'1000000001'};
const records=Array.from({length:65},(_,index)=>({post_type:'message',message_type:'group',group_id:C.id,user_id:'3001',sender:{user_id:'3001'},self_id:'999',message_id:String(100-index),time:NOW/1000-100+index,message:[{type:'text',data:{text:'offline'}}]}));
const adapter={readOlderGroupPage:async({before})=>{const index=records.findIndex(row=>row.message_id===before);return records.slice(Math.max(0,index-19),index+1);}};
test('h2 reaches retained boundary and restarts explicitly after bounded fetch; old h2 fails rather than mixing snapshots',async t=>{
  const queue=new ScopedEventStore(':memory:',{policy:createScopedConversationPolicy({allowedGroups:[C.id]}),clock:()=>NOW});t.after(()=>queue.close());for(const row of records.slice(-20))queue.ingest(row);
  const backfill=new BoundedGroupBackfill(queue,adapter);
  let page=await backfill.readHistory({conversation:C,limit:5,backfill_pages:0});const old=page.next_before;
  page=await backfill.readHistory({conversation:C,cursor:page.next_before,backfill_pages:0});
  page=await backfill.readHistory({conversation:C,cursor:page.next_before,backfill_pages:0});
  const boundary=page.next_before,pageResult=await backfill.readHistory({conversation:C,cursor:boundary,backfill_pages:1});
  assert.equal(pageResult.backfill.pages,1);assert.equal(pageResult.backfill.snapshot_restarted,true);assert.ok(pageResult.next_before);
  await assert.rejects(backfill.readHistory({conversation:C,cursor:old}),e=>e.code==='cursor_scope_mismatch');
});
test('cache/e1 survives reopen; revocation clears data and reapproval cannot reuse old history authority',async t=>{
  const root=fs.mkdtempSync(path.join(fileURLToPath(new URL('.',import.meta.url)),'backfill-persist-'));t.after(()=>fs.rmSync(root,{recursive:true}));const db=path.join(root,'queue.sqlite');
  const options={policy:createScopedConversationPolicy({allowedGroups:[C.id]}),clock:()=>NOW};let queue=new ScopedEventStore(db,options);for(const row of records.slice(-20))queue.ingest(row);
  let backfill=new BoundedGroupBackfill(queue,adapter);const page=await backfill.readHistory({conversation:C,before:'55',backfill_pages:1}),record=page.messages[0];queue.close();
  queue=new ScopedEventStore(db,options);backfill=new BoundedGroupBackfill(queue,adapter);assert.equal(backfill.store.getRetainedMessage({conversation:C,cursor:record.cursor}).message_id,record.message_id);queue.close();
  queue=new ScopedEventStore(db,{policy:createScopedConversationPolicy(),clock:()=>NOW});backfill=new BoundedGroupBackfill(queue,adapter);assert.equal(queue.db.prepare('SELECT COUNT(*) AS n FROM sr_history_cache').get().n,0);queue.close();
  queue=new ScopedEventStore(db,options);backfill=new BoundedGroupBackfill(queue,adapter);assert.throws(()=>backfill.store.getRetainedMessage({conversation:C,cursor:record.cursor}),e=>e.code==='invalid_cursor');queue.close();
});
test('private existing h2/e1 authority is unchanged by group-only proxy',()=>{
  const queue=new ScopedEventStore(':memory:',{clock:()=>NOW});
  try{for(let id=1;id<=3;id++)queue.ingest({post_type:'message',message_type:'private',user_id:P.id,message_id:String(id),time:NOW/1000,message:[{type:'text',data:{text:'mock'}}]});
    const original=createScopedHistoryTools(queue),page=original.readHistory({conversation:P,limit:1});const backfill=new BoundedGroupBackfill(queue,adapter);
    assert.deepEqual(backfill.history.readHistory({conversation:P,cursor:page.next_before}),original.readHistory({conversation:P,cursor:page.next_before}));
    assert.equal(backfill.store.realtimeCursor(P,2),queue.cursor(P,2));
  }finally{queue.close();}
});
test('new same-second bridge cannot silently reorder an existing h2 snapshot', async t => {
  const queue = new ScopedEventStore(':memory:', {policy: createScopedConversationPolicy({allowedGroups: [C.id]}), clock: () => NOW});
  t.after(() => queue.close());
  const raw = id => ({post_type: 'message', message_type: 'group', group_id: C.id, user_id: '3001', message_id: id, time: NOW / 1000, message: [{type: 'text', data: {text: 'offline'}}]});
  queue.ingest(raw('1')); queue.ingest(raw('2'));
  const backfill = new BoundedGroupBackfill(queue, adapter);
  const page = await backfill.readHistory({conversation: C, limit: 1, backfill_pages: 0});
  assert.deepEqual(page.messages.map(row => row.message_id), ['2']);
  queue.ingest(raw('3'));
  backfill.observeNativeLive(C, [raw('2'), raw('3'), raw('1')]);
  await assert.rejects(backfill.readHistory({conversation: C, cursor: page.next_before, backfill_pages: 0}), error => error.code === 'cursor_scope_mismatch');
});
test('evicting native ordering evidence invalidates existing h2 snapshots', async t => {
  const queue = new ScopedEventStore(':memory:', {policy: createScopedConversationPolicy({allowedGroups: [C.id]}), clock: () => NOW});
  t.after(() => queue.close());
  const raw = id => ({post_type: 'message', message_type: 'group', group_id: C.id, user_id: '3001', message_id: id, time: NOW / 1000, message: [{type: 'text', data: {text: 'offline'}}]});
  queue.ingest(raw('1')); queue.ingest(raw('2'));
  const backfill = new BoundedGroupBackfill(queue, adapter);
  backfill.observeNativeLive(C, [raw('2'), raw('1')]);
  const insert = queue.db.prepare('INSERT INTO sr_history_edges VALUES(?,?,?)');
  for (let n = 10; n < 2009; n++) insert.run(`group:${C.id}`, String(n), String(n + 1));
  const page = await backfill.readHistory({conversation: C, limit: 1, backfill_pages: 0});
  assert.deepEqual(page.messages.map(row => row.message_id), ['1']);
  backfill.observeNativeLive(C, [raw('3000'), raw('3001')]);
  await assert.rejects(backfill.readHistory({conversation: C, cursor: page.next_before, backfill_pages: 0}), error => error.code === 'cursor_scope_mismatch');
});
