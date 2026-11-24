import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.mjs';
import {execute,runAgent} from '../agent.mjs';
import {handleBookshop} from '../makers/handler.mjs';
const items=[{book_id:'B001',quantity:2},{book_id:'B002',quantity:1}];
test('合并预览、改量、确认幂等、库存流水和旧单据失效',()=>{
 const s=new Store();try{
 const first=execute(s,'a','preview_order',{items});
 assert.equal(first.total_cents,12980);assert.equal(first.items.length,2);assert.equal(first.items[0].quote_id,undefined);
 assert.equal(s.search({keyword:'B001'})[0].stock,10);
 assert.equal(s.context('a').previews.length,1);
 assert.throws(()=>s.reviseQuote('b',first.quote_id,items),/不存在/);
 assert.throws(()=>s.reviseQuote('a',first.quote_id,[{book_id:'B001',quantity:20}]),/库存不足/);
 assert.equal(s.context('a').previews[0].quote_id,first.quote_id);
 const q=execute(s,'a','preview_order',{quote_id:first.quote_id,items:[{book_id:'B001',quantity:3},items[1]]});
 assert.equal(q.total_cents,17480);assert.throws(()=>s.confirm('a',first.quote_id),/不存在/);
 const child=JSON.parse(s.db.prepare('SELECT quotes FROM cart_quotes WHERE id=?').get(q.quote_id).quotes)[0];
 assert.throws(()=>s.confirm('a',child),/整笔/);
 assert.throws(()=>s.reviseQuote('a',child,1),/整笔/);
 assert.throws(()=>s.confirm('b',q.quote_id),/不存在/);
 const o=s.confirm('a',q.quote_id);assert.equal(o.items.length,2);assert.equal(o.items[0].stock_after,7);
 assert.equal(s.orders('a').length,1);assert.equal(s.orders('a')[0].total_cents,17480);
 assert.equal(s.confirm('a',q.quote_id).id,o.id);assert.equal(s.confirm('a',q.quote_id).replayed,true);
 assert.equal(s.search({keyword:'B001'})[0].stock,7);assert.equal(s.search({keyword:'B002'})[0].stock,7);
 assert.equal(s.stockHistory('B001').movements.length,1);assert.throws(()=>s.order('b',o.id),/不存在/);
 assert.equal(execute(s,'a','get_order',{}).id,o.id);assert.equal(s.previews('a').length,0);
 }finally{s.close();}
});
test('合并确认任一项库存或价格变化时整笔回滚，无部分扣减',()=>{
 for(const mutation of ["UPDATE books SET stock=0 WHERE id='B002'","UPDATE books SET price=1 WHERE id='B002'"]){
 const s=new Store();try{
 const q=s.quote('a',{items});s.db.exec(mutation);
 assert.throws(()=>s.confirm('a',q.quote_id),/库存或价格/);
 assert.equal(s.search({keyword:'B001'})[0].stock,10);assert.equal(s.orders('a').length,0);assert.equal(s.stockHistory('B001').movements.length,0);
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
 }finally{s.close();}}
});
test('合并清单重复项、数量、空清单被拒绝，过期预览可恢复但不能确认',()=>{
 const s=new Store();try{
 for(const rows of [[],[items[0],items[0]],[{book_id:'B001',quantity:21}],[{book_id:'B001',quantity:1,total_cents:1}]])assert.throws(()=>s.quote('a',{items:rows}));
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM quotes').get().n,0);
 const q=s.quote('a',{items});s.db.prepare('UPDATE cart_quotes SET expires=0 WHERE id=?').run(q.quote_id);
 assert.throws(()=>s.confirm('a',q.quote_id),/过期/);assert.equal(s.previews('a')[0].quote_id,q.quote_id);assert.equal(s.context('a').previews.length,0);
 assert.equal(s.previews('b').length,0);
 }finally{s.close();}
});
test('模拟模型使用 items 创建合并预览，保持人工确认',async()=>{
 const s=new Store();let calls=0;try{
 await runAgent({store:s,session:'a',message:'B001两本、B002一本合并下单',emit:()=>{},config:{key:'test',model:'mock',base:'https://example.invalid/v1'},fetcher:async()=>({ok:true,json:async()=>({choices:[{message:calls++===0?{role:'assistant',content:null,tool_calls:[{id:'cart1',type:'function',function:{name:'preview_order',arguments:JSON.stringify({items})}}]}:{role:'assistant',content:'请核对合并预览。'}}]})})});
 assert.equal(calls,2);assert.equal(s.context('a').previews[0].items.length,2);assert.equal(s.orders('a').length,0);
 }finally{s.close();}
});
test('Makers SQL.js 快照恢复合并预览和订单，访客会话隔离',async()=>{
 const map=new Map(),sid='10000000-0000-4000-8000-000000000001';
 const call=async(path,data={},id=sid)=>handleBookshop({request:{method:'POST',headers:{'makers-conversation-id':id},body:{path,data}},conversation_id:id,env:{},store:{state:{get:async k=>map.get(id+k),set:async(k,v)=>map.set(id+k,v)}}});
 const q=await (await call('/api/preview',{items})).json();assert.equal(q.total_cents,12980);
 const workspace=await (await call('/api/workspace')).json();assert.equal(workspace.previews.length,1);assert.notEqual(workspace.scope,sid);
 assert.equal((await call('/api/confirm',{quote_id:q.quote_id},'10000000-0000-4000-8000-000000000002')).status,404);
 const o=await(await call('/api/confirm',{quote_id:q.quote_id})).json();assert.equal(o.items.length,2);
 const replay=await(await call('/api/confirm',{quote_id:q.quote_id})).json();assert.equal(replay.id,o.id);assert.equal(replay.replayed,true);
 const orders=await(await call('/api/orders')).json();assert.equal(orders.length,1);assert.equal(orders[0].items.length,2);
 assert.equal((await(await call('/api/workspace')).json()).previews.length,0);
});


test('大量合并子报价不会挤掉独立单本预览',()=>{
 const s=new Store();try{
  const single=s.quote('a',{book_id:'B001',quantity:1});
  const books=s.search().filter(x=>x.stock>0).slice(0,10).map(x=>({book_id:x.id,quantity:1}));
  for(let i=0;i<4;i++)s.quote('a',{items:books});
  const restored=s.previews('a');
  assert.equal(restored.length,5);assert(restored.some(x=>x.quote_id===single.quote_id));
  assert.equal(restored.filter(x=>x.items).length,4);
 }finally{s.close();}
});
