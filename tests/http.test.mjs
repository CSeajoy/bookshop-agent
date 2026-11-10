import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';

async function start(db,model={}){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',BOOKSHOP_DB:db,MODEL_API_KEY:'',MODEL_NAME:'',...model},stdio:['ignore','pipe','pipe']});
 let output='';
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}};
 try{
  const base=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('服务启动超时：'+output)),8000);
   child.stdout.on('data',chunk=>{output+=chunk;const url=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(url){clearTimeout(timer);resolve(url[0]);}});
   child.stderr.on('data',chunk=>{output+=chunk;});
   child.once('error',e=>{clearTimeout(timer);reject(e);});
   child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});
  });
  return {base,stop};
 }catch(e){await stop();throw e;}
}
function client(server){
 let cookie;
 return {
  get cookie(){return cookie;},
  set cookie(value){cookie=value;},
  async request(path,data,signal){const headers=cookie?{Cookie:cookie}:{};if(data!==undefined)headers['Content-Type']='application/json';const r=await fetch(server.base+path,{headers,method:data===undefined?'GET':'POST',body:data===undefined?undefined:JSON.stringify(data),signal});cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;return r;}
 };
}
test('HTTP：预览改量、售出与入库流水、幂等、重启恢复和会话隔离',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bookshop-http-'));let server;
 try{
  const db=join(dir,'orders.sqlite');server=await start(db);
  const c=client(server);
  const books=await (await c.request('/api/books')).json();
  assert.equal(books.length,24);assert.equal(books.find(b=>b.id==='B001').category,'数据库');
  const stock=async cli=>(await (await cli.request('/api/books')).json()).find(b=>b.id==='B001').stock;
  const history=async cli=>(await (await cli.request('/api/stock?book_id=B001')).json());
  const invalid=await c.request('/api/preview',{book_id:'B001',quantity:0});
  assert.equal(invalid.status,400);
  const insufficient=await c.request('/api/preview',{book_id:'B001',quantity:11});
  assert.equal(insufficient.status,409);
  const sse=await (await c.request('/api/chat',{mode:'demo',action:'preview',book_id:'B001',quantity:2,message:'测试预览'})).text();
  const demo=JSON.parse(sse.match(/event: tool_result\ndata: (.+)/)[1]).result;
  const preview=await c.request('/api/preview',{book_id:'B001',quantity:2});
  assert.equal(preview.status,200);
  const q=await preview.json();
  assert.notEqual(q.quote_id,demo.quote_id);
  assert.equal(q.total_cents,demo.total_cents);
  assert.equal(await stock(c),10);assert.equal(q.total_cents,9000);
  assert.deepEqual(await (await c.request('/api/orders')).json(),[]);
  assert.equal((await client(server).request('/api/confirm',{quote_id:q.quote_id})).status,404);
  assert.equal(q.unit_price_cents,4500);assert.equal(q.stock_at_preview,10);
  const edit={quote_id:q.quote_id,quantity:3};
  assert.equal((await client(server).request('/api/preview',edit)).status,404);
  assert.equal((await c.request('/api/preview',{...edit,quantity:11})).status,409);
  const revision=await c.request('/api/preview',edit);
  assert.equal(revision.status,200);
  const revised=await revision.json();
  assert.notEqual(revised.quote_id,q.quote_id);
  assert.equal(revised.quantity,3);
  assert.equal(revised.total_cents,13500);
  assert.equal((await c.request('/api/confirm',{quote_id:q.quote_id})).status,404);
  assert.equal(await stock(c),10);
  assert.deepEqual((await history(c)).movements,[]);
  const order=await (await c.request('/api/confirm',{quote_id:revised.quote_id})).json();
  assert.equal(order.stock_before,10);assert.equal(order.stock_after,7);
  assert.equal(order.quantity,3);
  assert.equal((await c.request('/api/preview',{quote_id:revised.quote_id,quantity:1})).status,409);
  const replay=await (await c.request('/api/confirm',{quote_id:revised.quote_id})).json();
  assert.equal(replay.id,order.id);assert.equal(replay.replayed,true);assert.equal(await stock(c),7);
  assert.equal(replay.stock_before,undefined);assert.equal(replay.stock_after,undefined);
  const sale=(await history(c)).movements;
  assert.equal(sale.length,1);
  assert.deepEqual([sale[0].kind,sale[0].delta,sale[0].stock_before,sale[0].stock_after],['sale',-3,10,7]);
  assert.equal(sale[0].order_id,undefined);
  const arrival={book_id:'B001',quantity:5,request_id:'10000000-0000-4000-8000-000000000001'};
  assert.equal((await c.request('/api/restock',{...arrival,quantity:0})).status,400);
  assert.equal((await c.request('/api/restock',{...arrival,book_id:'UNKNOWN'})).status,404);
  const responses=await Promise.all([c.request('/api/restock',arrival),c.request('/api/restock',arrival)]);
  const arrivals=await Promise.all(responses.map(response=>{
   assert.equal(response.status,200);
   return response.json();
  }));
  assert.equal(arrivals[0].id,arrivals[1].id);
  assert.equal(arrivals.filter(x=>x.replayed).length,1);
  assert.equal((await c.request('/api/restock',{...arrival,quantity:6})).status,409);
  assert.equal(await stock(c),12);
  const snapshot=await history(c);
  assert.equal(snapshot.stock,12);
  assert.deepEqual(snapshot.movements.map(m=>[m.kind,m.delta,m.stock_before,m.stock_after]),[
   ['restock',5,7,12],['sale',-3,10,7],
  ]);
  const cookie=c.cookie;await server.stop();server=await start(db);
  const restored=client(server);restored.cookie=cookie;
  assert.equal((await (await restored.request('/api/orders')).json())[0].id,order.id);
  assert.equal((await (await restored.request('/api/order?id='+order.id)).json()).total_cents,13500);
  assert.equal((await client(server).request('/api/order?id='+order.id)).status,404);
  assert.equal(await stock(restored),12);
  assert.deepEqual(await history(restored),snapshot);
  const restoredArrival=await (await restored.request('/api/restock',arrival)).json();
  assert.equal(restoredArrival.replayed,true);
  assert.equal(await stock(restored),12);
 }finally{await server?.stop();await rm(dir,{recursive:true,force:true});}
});

test('HTTP：客户端停止后取消模型请求，同一会话可继续使用',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bookshop-stop-'));let server;
 let received,closed;
 const requestStarted=new Promise(resolve=>{received=resolve;});
 const upstreamClosed=new Promise(resolve=>{closed=resolve;});
 const upstream=createServer((req,res)=>{res.once('close',closed);req.resume();received();});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 try{
  server=await start(join(dir,'orders.sqlite'),{MODEL_BASE_URL:'http://127.0.0.1:'+upstream.address().port+'/v1',MODEL_API_KEY:'test-only',MODEL_NAME:'mock',MODEL_TRANSPORT:'fetch'});
  const c=client(server);await (await c.request('/api/books')).json();
  const controller=new AbortController();const response=await c.request('/api/chat',{mode:'live',message:'测试停止'},controller.signal);
  await requestStarted;controller.abort();
  const deadline=AbortSignal.timeout(4000);
  await Promise.race([upstreamClosed,once(deadline,'abort').then(()=>{throw Error('上游连接未取消');})]);
  await assert.rejects(response.text(),{name:'AbortError'});
  let next;
  for(let i=0;i<10;i++){next=await c.request('/api/chat',{mode:'demo',message:'重新查询'});if(next.status!==409)break;await next.text();await new Promise(r=>setTimeout(r,40));}
  assert.equal(next.status,200);assert.match(await next.text(),/event: done/);
 }finally{await server?.stop();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true,force:true});}
});
