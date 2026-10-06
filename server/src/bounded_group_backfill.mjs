import {normalizeHistory} from './scoped_events.mjs';
import {EventFailure,scopeKey,parseConversation,validMessageId,snapshot} from './scoped_policy.mjs';
import {createScopedHistoryTools} from './scoped_history.mjs';
const fail=(status,code)=>{throw new EventFailure(status,code);};
const TTL=86400000,MAX=1000;
// Separate history-only cache. No append/ingest/page/inbox/read-state calls during backfill.
export class BoundedGroupBackfill {
  constructor(queue,adapter,{selfId,errorFactory}={}){
    if(typeof queue?.historySnapshot!=='function'||typeof adapter?.readOlderGroupPage!=='function')throw new TypeError('scoped queue/fixed paging adapter required');
    this.queue=queue;this.adapter=adapter;this.selfId=selfId;this.pending=new Map();
    queue.db.exec(`CREATE TABLE IF NOT EXISTS sr_history_meta(scope TEXT PRIMARY KEY,epoch TEXT NOT NULL,high INTEGER NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sr_history_positions(scope TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(scope,message_id),UNIQUE(scope,seq));
      CREATE TABLE IF NOT EXISTS sr_history_cache(scope TEXT NOT NULL,message_id TEXT NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,message_id));
      CREATE TABLE IF NOT EXISTS sr_history_edges(scope TEXT NOT NULL,older TEXT NOT NULL,newer TEXT NOT NULL,PRIMARY KEY(scope,older,newer));`);
    const overrides={authorize:chat=>this.authorize(chat),historySnapshot:chat=>this.historySnapshot(chat),cursor:(chat,seq)=>this.cursor(chat,seq),
      getRetainedMessage:input=>this.getRetainedMessage(input),resolveReply:input=>this.resolveReply(input),realtimeCursor:(chat,seq)=>queue.cursor(chat,seq)};
    this.store=new Proxy(queue,{get:(target,key)=>Object.hasOwn(overrides,key)?overrides[key]:typeof target[key]==='function'?target[key].bind(target):target[key]});
    this.history=createScopedHistoryTools(this.store,{errorFactory});
    for(const row of queue.db.prepare('SELECT scope FROM sr_history_meta').all()){
      const split=row.scope.indexOf(':');try{this.authorize({type:row.scope.slice(0,split),id:row.scope.slice(split+1)});}catch{}
    }
  }
  clear(scope){for(const table of ['sr_history_cache','sr_history_positions','sr_history_edges','sr_history_meta'])this.queue.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);}
  authorize(input){
    const chat=parseConversation(input),scope=scopeKey(chat);let canonical;
    try{canonical=this.queue.authorize(chat);}catch(error){this.clear(scope);throw error;}
    const epoch=this.queue._scope(chat).epoch,meta=this.queue.db.prepare('SELECT * FROM sr_history_meta WHERE scope=?').get(scope);
    if(meta&&meta.epoch!==epoch)this.clear(scope);
    this.queue.db.prepare('INSERT OR IGNORE INTO sr_history_meta VALUES(?,?,0,0)').run(scope,epoch);return canonical;
  }
  position(chat,id){
    const db=this.queue.db,scope=scopeKey(chat),known=db.prepare('SELECT seq FROM sr_history_positions WHERE scope=? AND message_id=?').get(scope,id);if(known)return known.seq;
    const high=db.prepare('SELECT high FROM sr_history_meta WHERE scope=?').get(scope).high;if(!Number.isSafeInteger(high+1))fail(503,'history_capacity_exceeded');
    db.prepare('INSERT INTO sr_history_positions VALUES(?,?,?)').run(scope,id,high+1);db.prepare('UPDATE sr_history_meta SET high=? WHERE scope=?').run(high+1,scope);return high+1;
  }
  observeNativeLive(input,raw){
    const chat=this.authorize(input);if(chat.type!=='group')return;
    if(!Array.isArray(raw)||raw.length>20)return;
    const ids=raw.map(row=>String(row.message_id));if(raw.some((row,index)=>String(row.group_id)!==chat.id||!validMessageId(ids[index])||!Number.isSafeInteger(row.time)||index&&row.time<raw[index-1].time))return;
    this.queue.tx(()=>{
      const db=this.queue.db,scope=scopeKey(chat);let changesToKnownOrder=0;
      // A new endpoint can bridge known messages and change their relative order.
      // Invalidate conservatively when either endpoint already has cursor authority.
      for(let i=1;i<raw.length;i++)if(raw[i].time===raw[i-1].time){
        const added=db.prepare('INSERT OR IGNORE INTO sr_history_edges VALUES(?,?,?)').run(scope,ids[i-1],ids[i]).changes;
        if(added&&db.prepare('SELECT COUNT(*) AS n FROM sr_history_positions WHERE scope=? AND message_id IN (?,?)').get(scope,ids[i-1],ids[i]).n>0)changesToKnownOrder++;
      }
      const count=db.prepare('SELECT COUNT(*) AS n FROM sr_history_edges WHERE scope=?').get(scope).n;
      if(count>2000){db.prepare('DELETE FROM sr_history_edges WHERE rowid IN (SELECT rowid FROM sr_history_edges WHERE scope=? ORDER BY rowid LIMIT ?)').run(scope,count-2000);changesToKnownOrder++;}
      if(changesToKnownOrder)db.prepare('UPDATE sr_history_meta SET generation=generation+1 WHERE scope=?').run(scope);
    });
  }
  tombstone(chat,payload){
    const recall=this.queue.db.prepare('SELECT time FROM sr_recalls WHERE scope=? AND message_id=? AND expires>?').get(scopeKey(chat),payload.message_id,this.queue.now());
    if(recall&&recall.time>=payload.time)return {...payload,state:'withdrawn',messages:[],reply_to:null};return payload;
  }
  historySnapshot(input){
    const chat=this.authorize(input);if(chat.type!=='group')return this.queue.historySnapshot(chat);
    const scope=scopeKey(chat),db=this.queue.db,live=this.queue.historySnapshot(chat),byId=new Map();
    for(const row of live.records)byId.set(row.message_id,{...row,live_seq:row.seq});
    db.prepare('DELETE FROM sr_history_cache WHERE expires<=?').run(this.queue.now());
    for(const row of db.prepare('SELECT expires,payload FROM sr_history_cache WHERE scope=?').all(scope)){
      const value=this.tombstone(chat,JSON.parse(row.payload));if(!byId.has(value.message_id))byId.set(value.message_id,{...value,expires:row.expires});
    }
    if(byId.size>2000)fail(503,'history_capacity_exceeded');
    const records=this.queue.tx(()=>[...byId.values()].map(row=>({...row,seq:this.position(chat,row.message_id)})));
    // Native same-second precedence edges, never short-ID lexical/numeric order.
    const edges=db.prepare('SELECT older,newer FROM sr_history_edges WHERE scope=?').all(scope),times=new Map();
    for(const row of records){if(!times.has(row.time))times.set(row.time,[]);times.get(row.time).push(row);}
    for(const peers of times.values()){
      const ids=new Set(peers.map(row=>row.message_id)),degrees=new Map(peers.map(row=>[row.message_id,0])),next=new Map();
      for(const edge of edges)if(ids.has(edge.older)&&ids.has(edge.newer)){degrees.set(edge.newer,degrees.get(edge.newer)+1);if(!next.has(edge.older))next.set(edge.older,[]);next.get(edge.older).push(edge.newer);}
      let ready=peers.filter(row=>degrees.get(row.message_id)===0).sort((a,b)=>a.seq-b.seq),rank=0;
      while(ready.length){const row=ready.shift();row.native_order=++rank;for(const id of next.get(row.message_id)??[]){degrees.set(id,degrees.get(id)-1);if(degrees.get(id)===0){ready.push(peers.find(row=>row.message_id===id));ready.sort((a,b)=>a.seq-b.seq);}}}
      if(rank!==peers.length)fail(503,'history_order_conflict');
    }
    records.sort((a,b)=>a.time-b.time||a.native_order-b.native_order);
    const meta=db.prepare('SELECT * FROM sr_history_meta WHERE scope=?').get(scope);
    const liveIds=new Set(records.map(row=>row.message_id));
    for(const row of db.prepare('SELECT message_id FROM sr_history_positions WHERE scope=?').all(scope))if(!liveIds.has(row.message_id))db.prepare('DELETE FROM sr_history_positions WHERE scope=? AND message_id=?').run(scope,row.message_id);
    return {...live,records,high:meta.high,floor:0,scope_epoch:meta.epoch+':history'+meta.generation,
      coverage:{...live.coverage,retained_only:true,history_backfill:{source:'bounded_on_demand_group_history',cached_rows:db.prepare('SELECT COUNT(*) AS n FROM sr_history_cache WHERE scope=?').get(scope).n,upstream_complete:false}}};
  }
  cursor(input,seq){
    const chat=this.authorize(input);if(chat.type!=='group'||seq===0)return this.queue.cursor(chat,seq);
    const row=this.queue.db.prepare('SELECT message_id FROM sr_history_positions WHERE scope=? AND seq=?').get(scopeKey(chat),seq);
    const live=row&&this.queue.historySnapshot(chat).records.find(item=>item.message_id===row.message_id);
    if(live)return this.queue.cursor(chat,live.seq);
    return this.queue.signToken('e1',{v:1,kind:'history',stream_id:this.queue.streamId,conversation:chat,scope_epoch:this.queue._scope(chat).epoch,seq});
  }
  getRetainedMessage({conversation,cursor}){
    const chat=this.authorize(conversation);let token;
    if(typeof cursor==='string'&&cursor.startsWith('e1.'))token=this.queue.verifyToken('e1',cursor);
    if(token?.kind!=='history')return this.queue.getRetainedMessage({conversation:chat,cursor});
    if(Object.keys(token).sort().join(',')!=='conversation,kind,scope_epoch,seq,stream_id,v'||token.v!==1||!Number.isSafeInteger(token.seq)||token.seq<1)fail(400,'invalid_cursor');
    if(scopeKey(parseConversation(token.conversation))!==scopeKey(chat))fail(403,'cursor_conversation_mismatch');
    if(token.stream_id!==this.queue.streamId||token.scope_epoch!==this.queue._scope(chat).epoch)fail(400,'invalid_cursor');
    const row=this.queue.db.prepare('SELECT cache.expires,cache.payload FROM sr_history_cache AS cache JOIN sr_history_positions AS pos ON cache.scope=pos.scope AND cache.message_id=pos.message_id WHERE pos.scope=? AND pos.seq=? AND cache.expires>?').get(scopeKey(chat),token.seq,this.queue.now());
    if(!row)fail(404,'media_not_found');return {cursor,...this.tombstone(chat,JSON.parse(row.payload)),expires_at:row.expires};
  }
  resolveReply(input){
    const chat=this.authorize(input.conversation);if(!validMessageId(input.message_id))fail(400,'invalid_reply');
    let row;try{row=this.getRetainedMessage(input);}catch(error){if(error.code==='media_not_found')return null;throw error;}
    if(row.message_id!==input.message_id||row.state!=='available')return null;
    let expires=row.expires_at;if(expires===undefined){const retained=this.queue.historySnapshot(chat).records.find(item=>item.message_id===row.message_id);expires=retained?.expires;}
    if(!Number.isSafeInteger(expires)||expires<=this.queue.now())return null;
    return {conversation:chat,cursor:input.cursor,message_id:row.message_id,user_id:row.user_id,expires_at:expires};
  }
  async fetch(chat,anchor,budget){
    const key=scopeKey(chat),existing=this.pending.get(key);if(existing){await existing;return {pages:0,coalesced:true,incomplete:true};}
    const run=this.walk(chat,anchor,budget);this.pending.set(key,run);try{return await run;}finally{this.pending.delete(key);}
  }
  async walk(chat,anchor,budget){
    let pages=0,added=0,unrepresentable=0,reason='page_budget',current=anchor;const started=Date.now();
    for(;pages<budget;){
      this.authorize(chat);if(Date.now()-started>8500){reason='time_budget';break;}
      let raw;try{raw=await this.adapter.readOlderGroupPage({conversation:chat,before:current,limit:20});}catch{reason='upstream_unavailable';break;}
      pages++;this.authorize(chat);
      if(!Array.isArray(raw)||raw.length>20){reason='invalid_page';break;}
      let rows;try{rows=raw.map(record=>{const item=normalizeHistory(record,chat,this.queue.now(),{selfId:this.selfId});if(item.rejected){unrepresentable++;return {message_id:String(record.message_id),time:record.time,unrepresentable:true};}return item.value;});}catch{reason='invalid_page';break;}
      if(rows.length===0){reason='empty_unverified';break;}
      if(rows.at(-1).message_id!==current||new Set(rows.map(row=>row.message_id)).size!==rows.length||rows.some((row,index)=>index&&row.time<rows[index-1].time)){reason='anchor_or_order_mismatch';break;}
      try{const live=this.queue.historySnapshot(chat).records;added+=this.queue.tx(()=>{
        const db=this.queue.db,scope=scopeKey(chat),known=new Map(live.map(row=>[row.message_id,row]));let changed=0,count=0;
        for(const row of db.prepare('SELECT payload FROM sr_history_cache WHERE scope=?').all(scope)){const value=JSON.parse(row.payload);known.set(value.message_id,value);}
        for(const value of rows.filter(row=>!row.unrepresentable)){const previous=known.get(value.message_id);if(previous&&previous.time!==value.time)fail(503,'history_identity_conflict');
          this.position(chat,value.message_id);
          if(!previous){if(db.prepare('SELECT COUNT(*) AS n FROM sr_history_cache WHERE scope=?').get(scope).n>=MAX)fail(503,'history_capacity_exceeded');db.prepare('INSERT INTO sr_history_cache VALUES(?,?,?,?)').run(scope,value.message_id,this.queue.now()+TTL,JSON.stringify(value));count++;changed++;}}
        const supported=rows.filter(row=>!row.unrepresentable);
        for(let i=1;i<supported.length;i++)if(supported[i].time===supported[i-1].time)changed+=db.prepare('INSERT OR IGNORE INTO sr_history_edges VALUES(?,?,?)').run(scope,supported[i-1].message_id,supported[i].message_id).changes;
        if(changed)db.prepare('UPDATE sr_history_meta SET generation=generation+1 WHERE scope=?').run(scope);
        const outgoing=new Map();for(const edge of db.prepare('SELECT older,newer FROM sr_history_edges WHERE scope=?').all(scope)){if(!outgoing.has(edge.older))outgoing.set(edge.older,[]);outgoing.get(edge.older).push(edge.newer);}
        const visiting=new Set(),done=new Set();const visit=id=>{if(visiting.has(id))fail(503,'history_order_conflict');if(done.has(id))return;visiting.add(id);for(const next of outgoing.get(id)??[])visit(next);visiting.delete(id);done.add(id);};for(const id of outgoing.keys())visit(id);
        return count;
      });}catch(error){reason=error.code??'cache_unavailable';break;}
      if(rows.length===1||rows[0].message_id===current){reason='anchor_stalled';break;}current=rows[0].message_id;
    }
    return {pages,added_rows:added,unrepresentable_rows:unrepresentable,next_anchor:current,incomplete:true,upstream_complete:false,reason,requested_pages:budget,max_rows_requested:budget*20};
  }
  async readHistory(input){
    const captured=snapshot(input);if(!captured||typeof captured!=='object'||Array.isArray(captured))fail(400,'invalid_request');
    const budget=Object.hasOwn(captured,'backfill_pages')?captured.backfill_pages:2;if(!Number.isInteger(budget)||budget<0||budget>2)fail(400,'invalid_backfill_budget');
    const refresh=Object.hasOwn(captured,'refresh_before')?captured.refresh_before:false;
    if(typeof refresh!=='boolean'||refresh&&(typeof captured.before!=='string'||captured.cursor!==undefined))fail(400,'invalid_request');
    delete captured.refresh_before;
    delete captured.backfill_pages;const chat=this.authorize(captured.conversation);let result=this.history.readHistory(captured);
    const enabled=chat.type==='group'&&budget>0;
    if(!enabled)return {...result,backfill:{pages:0,incomplete:true,reason:budget===0?'disabled':'scope_not_enabled'}};
    const continuation=captured.cursor?this.queue.verifyToken('h2',captured.cursor):null;
    const direction=continuation?.direction??(captured.after!==undefined?'after':captured.around!==undefined?'around':'before');
    const needs=direction==='before'&&(refresh||result.messages.length<(captured.limit??continuation?.query.limit??20)||result.next_before===null);
    if(!needs)return {...result,backfill:{pages:0,incomplete:true,reason:'retained_page_available'}};
    const source=this.historySnapshot(chat),earliest=source.records.find(row=>row.expires>source.now);
    if(!earliest)return {...result,backfill:{pages:0,incomplete:true,reason:'no_retained_anchor'}};
    if(refresh&&!source.records.some(row=>row.message_id===captured.before))fail(404,'history_anchor_unavailable');
    const info=await this.fetch(chat,refresh?captured.before:earliest.message_id,budget);
    // Snapshot restart is explicit: old h2 cannot silently include newly fetched older rows.
    const request=continuation?{conversation:chat,before:continuation.position.message_id,limit:continuation.query.limit}:captured;
    result=this.history.readHistory(request);return {...result,backfill:{...info,snapshot_restarted:!!continuation}};
  }
}
