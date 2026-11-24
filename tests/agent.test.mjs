import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.mjs';
import {runAgent,execute,tools} from '../agent.mjs';
import {searchRules,buildIndex} from '../retrieval.mjs';
import {relayOpenAI} from '../gateway.mjs';
const config={key:'mock-key',model:'test-model',base:'https://example.invalid/v1'};
function response(message,finish='stop'){return new Response(JSON.stringify({id:'c1',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}),{headers:{'Content-Type':'application/json'}});}
test('真正AI SDK适配器：工具请求、执行、工具结果回传、最终回答',async()=>{const store=new Store();let n=0;const sent=[],events=[];try{const h=await runAgent({store,session:'sdk',message:'查询数据库书',config,transport:'sdk',emit:(e,d)=>events.push([e,d]),fetcher:async(url,o)=>{sent.push(JSON.parse(o.body));return n++===0?response({role:'assistant',content:null,tool_calls:[{id:'x1',type:'function',function:{name:'search_books',arguments:'{"keyword":"数据库"}'}}]},'tool_calls'):response({role:'assistant',content:'库存查询已完成。'});}});assert.equal(sent.length,2);assert.equal(sent[1].messages.at(-1).role,'tool');assert.equal(sent[1].messages.at(-1).tool_call_id,'x1');assert.equal(h.at(-1).content,'库存查询已完成。');assert(events.some(([e,d])=>e==='status'&&d.node==='execute_tools'));assert.equal(store.orders('sdk').length,0);}finally{store.close()}});
test('规则词频向量检索有引用，无关问题无结果；索引复用',()=>{const rows=searchRules('订单预览有效期');assert(rows.length);assert(rows.some(r=>r.excerpt.includes('五分钟')));assert(rows.every(r=>r.source.endsWith('.md')));assert.equal(searchRules('qwertyzzzzzz').length,0);assert.equal(buildIndex().changed,0);});
test('未知工具和额外参数被拒绝',()=>{const s=new Store();try{assert.throws(()=>execute(s,'a','confirm_order',{}),/不受支持/);assert.throws(()=>execute(s,'a','search_books',{keyword:'',sql:'DELETE'}),/未知参数/);}finally{s.close()}});
test('达到调用上限后终止，不循环扣费',async()=>{const s=new Store();let count=0;try{await assert.rejects(runAgent({store:s,session:'a',message:'反复查',config,emit:()=>{},fetcher:async()=>{count++;return response({role:'assistant',content:null,tool_calls:[{id:'x'+count,type:'function',function:{name:'search_books',arguments:'{}'}}]},'tool_calls')}}),/调用上限/);assert.equal(count,4);}finally{s.close()}});
test('网关JSON透传不丢tools与tool_call_id',async()=>{let written,bodySeen;const res={writeHead(){},end(x){written=JSON.parse(x)}};await relayOpenAI({config,body:{model:config.model,messages:[{role:'assistant',content:null,tool_calls:[{id:'x',type:'function',function:{name:'search_books',arguments:'{}'}}]},{role:'tool',tool_call_id:'x',content:'[]'}],tools,stream:false},response:res,fetcher:async(u,o)=>{bodySeen=JSON.parse(o.body);return response({role:'assistant',content:'完成'})}});assert.equal(bodySeen.tools.length,4);assert.equal(bodySeen.messages[1].tool_call_id,'x');assert.equal(written.choices[0].message.content,'完成');});
test('网关SSE逐块透传，不丢工具参数片段和DONE',async()=>{const chunks=['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"}}]}}]}\n\n','data: [DONE]\n\n'];let out='';const r={destroyed:false,writeHead(){},write(x){out+=new TextDecoder().decode(x);return true},end(){}};await relayOpenAI({config,body:{model:config.model,messages:[{role:'user',content:'查询'}],tools,stream:true},response:r,fetcher:async()=>new Response(new ReadableStream({start(c){for(const x of chunks)c.enqueue(new TextEncoder().encode(x));c.close()}}),{headers:{'Content-Type':'text/event-stream'}})});assert.equal(out,chunks.join(''));});
test('网关拒绝配置外模型，不发出网络请求',async()=>{let called=false;await assert.rejects(relayOpenAI({config,body:{model:'paid-other',messages:[]},response:{},fetcher:async()=>{called=true}}),/已配置/);assert.equal(called,false)});

test('多轮修改预览和查询最近订单，旧预览失效且会话隔离',async()=>{
 const store=new Store();
 const events=[];
 const quote=store.quote('visitor',{book_id:'B001',quantity:2});
 let count=0;
 try{
  await runAgent({
   store,session:'visitor',message:'把刚才的预览改成三本',config,
   emit:(name,data)=>events.push([name,data]),
   fetcher:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(count++===0){
     assert(body.messages.some(message=>message.role==='system'&&message.content.includes(quote.quote_id)));
     return response({role:'assistant',content:null,tool_calls:[{id:'revise-1',type:'function',function:{name:'preview_order',arguments:JSON.stringify({quote_id:quote.quote_id,quantity:3})}}]},'tool_calls');
    }
    return response({role:'assistant',content:'已更新，请核对后确认。'});
   },
  });
  const revised=events.find(([name,data])=>name==='tool_result'&&data.name==='preview_order')[1].result;
  assert.equal(revised.quantity,3);
  assert.equal(revised.total_cents,13500);
  assert.equal(revised.replaces_quote_id,quote.quote_id);
  assert.equal(store.search({keyword:'B001'})[0].stock,10);
  assert.throws(()=>store.confirm('visitor',quote.quote_id),/预览不存在/);
  assert.throws(()=>execute(store,'other','preview_order',{quote_id:revised.quote_id,quantity:1}),/预览不存在/);
  const order=store.confirm('visitor',revised.quote_id);
  assert.equal(execute(store,'visitor','get_order',{}).id,order.id);
  assert.equal(store.search({keyword:'B001'})[0].stock,7);
  assert.equal(execute(store,'other','get_order',{}).error,'当前会话暂无订单');
  assert.equal(store.confirm('visitor',revised.quote_id).replayed,true);
 }finally{store.close();}
});


test('SDK错误只显示安全HTTP状态和域名，不泄露上游正文',async()=>{
 const s=new Store();try{
 await assert.rejects(runAgent({store:s,session:'diagnostic',message:'查询库存',emit:()=>{},config:{key:'secret-not-for-output',model:'mock',base:'https://example.invalid/v1',transport:'sdk'},transport:'sdk',fetcher:async()=>new Response(JSON.stringify({error:{message:'private-upstream-secret'}}),{status:401,headers:{'Content-Type':'application/json'}})}),error=>{
  assert.match(error.message,/HTTP 401/);assert.match(error.message,/example.invalid/);assert(!error.message.includes('private-upstream-secret'));assert(!error.message.includes('secret-not-for-output'));return true;
 });
 }finally{s.close();}
});
