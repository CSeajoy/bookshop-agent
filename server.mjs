import http from 'node:http';
import { readFileSync,mkdirSync } from 'node:fs';
import {fileURLToPath} from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store,BusinessError } from './store.mjs';
import {runAgent,execute} from './agent.mjs';
import {relayOpenAI} from './gateway.mjs';
import {searchRules,buildIndex} from './retrieval.mjs';
mkdirSync(new URL('./runtime/',import.meta.url),{recursive:true});
const store=new Store(process.env.BOOKSHOP_DB||fileURLToPath(new URL('./runtime/bookshop.sqlite',import.meta.url)));
const sessions=new Map();
const send=(r,status,data)=>{r.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});r.end(JSON.stringify(data));};
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16000)throw new BusinessError('请求过大',413);}try{return JSON.parse(text);}catch{throw new BusinessError('JSON格式无效');}}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(readFileSync(new URL('./web/index.html',import.meta.url)));}
  if(req.method==='GET'&&['/app.css','/app.js'].includes(url.pathname)){res.writeHead(200,{'Content-Type':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'application/javascript; charset=utf-8'});return res.end(readFileSync(new URL('./web'+url.pathname,import.meta.url)));}
  if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{status:'ok',live_configured:!!(process.env.MODEL_API_KEY&&process.env.MODEL_NAME)});
  if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/v1/'))return send(res,404,{error:'Not found'});
  // 本地工作台：拒绝跨站写请求。仅会话 cookie 可确定操作身份。
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return send(res,403,{error:'拒绝跨站请求'});
  let sid=/\bbs_session=([a-f0-9-]+)/.exec(req.headers.cookie||'')?.[1];
  if(sid&&!sessions.has(sid)){const saved=store.session(sid);if(saved)sessions.set(sid,saved);}
  if(!sessions.has(sid)){sid=randomUUID();sessions.set(sid,{history:[],busy:false,last:Date.now()});store.saveSession(sid,sessions.get(sid));res.setHeader('Set-Cookie',`bs_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);}
  const session=sessions.get(sid);session.last=Date.now();
  if(req.method==='GET'&&url.pathname==='/api/books')return send(res,200,store.search());
  if(req.method==='GET'&&url.pathname==='/api/stock')return send(res,200,store.stockHistory(url.searchParams.get('book_id')));
  if(req.method==='GET'&&url.pathname==='/api/order')return send(res,200,store.order(sid,url.searchParams.get('id')));
  if(req.method==='GET'&&url.pathname==='/api/orders')return send(res,200,store.orders(sid));
  if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
  const b=await body(req);
  if(!b||typeof b!=='object'||Array.isArray(b))throw new BusinessError('请求体须为JSON对象');
  if(url.pathname==='/v1/chat/completions'){if(session.busy)throw new BusinessError('请等待当前请求结束',409);session.busy=true;try{await relayOpenAI({body:b,config:{key:process.env.MODEL_API_KEY,model:process.env.MODEL_NAME,base:process.env.MODEL_BASE_URL||'https://apihub.agnes-ai.com/v1'},response:res});}catch(e){if(res.headersSent){if(!res.destroyed)res.end();}else send(res,502,{error:'模型网关请求失败，请检查配置或限流'});}finally{session.busy=false;}return;}
  if(url.pathname==='/api/rules')return send(res,200,searchRules(b.query));
  if(url.pathname==='/api/restock')return send(res,200,store.restock(b));
  if(url.pathname==='/api/preview'){
   if(session.busy)throw new BusinessError('请等待本轮结束',409);
   const quote=Object.hasOwn(b,'quote_id') ? store.reviseQuote(sid,b.quote_id,b.quantity) : store.quote(sid,b);
   return send(res,200,quote);
  }
  if(url.pathname==='/api/confirm'){if(session.busy)throw new BusinessError('请等待本轮结束',409);const o=store.confirm(sid,b.quote_id);if(!o.replayed)session.history.push({role:'user',content:`用户已在界面确认模拟订单，服务端结果：${JSON.stringify(o)}`});store.saveSession(sid,session);return send(res,200,o);}
  if(url.pathname==='/api/reset'){if(session.busy)throw new BusinessError('请等待本轮结束',409);session.history=[];store.saveSession(sid,session);return send(res,200,{ok:true});}
  if(url.pathname!=='/api/chat')return send(res,404,{error:'Not found'});
  if(!b||typeof b.message!=='string'||!b.message.trim()||b.message.length>1000)throw new BusinessError('请输入1至1000字');
  if(!['demo','live'].includes(b.mode))throw new BusinessError('请选择运行模式');
  if(session.busy)throw new BusinessError('同一会话已有请求进行中',409);session.busy=true;
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
  const cancel=new AbortController();res.on('close',()=>{if(!res.writableFinished)cancel.abort();});
  const emit=(event,data)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
  try{
   if(b.mode==='demo'){
    emit('status',{message:'规则演示：不调用大模型，非模型自主决策'});
    let args,name;if(b.action==='rules'){name='search_policies';args={query:b.query};}else if(b.action==='preview'){name='preview_order';args={book_id:b.book_id,quantity:b.quantity};}else{name='search_books';args={keyword:b.keyword||'',max_price:b.max_price??null};}
    emit('tool_start',{name});const result=execute(store,sid,name,args);emit('tool_result',{name,result});emit('answer',{text:name==='preview_order'?'模拟订单预览已生成，请核对后点击确认。':name==='search_policies'?'规则检索完成，原文依据见上方。':'已查询本地教学数据；选择图书可生成预览。'});
   }else{const h=await runAgent({store,session:sid,message:b.message,history:session.history,emit,signal:cancel.signal,config:{key:process.env.MODEL_API_KEY,base:process.env.MODEL_BASE_URL||'https://apihub.agnes-ai.com/v1',model:process.env.MODEL_NAME,transport:process.env.MODEL_TRANSPORT||'sdk'}});session.history=h;}
  }catch(e){emit('error',{message:e.status?e.message:(b.mode==='live'?e.message:'演示执行失败')});}
  finally{session.busy=false;store.saveSession(sid,session);emit('done',{});res.end();}
 }catch(e){send(res,e.status||500,{error:e.status?e.message:'服务器异常'});}
});
setInterval(()=>{for(const [k,v]of sessions)if(!v.busy&&Date.now()-v.last>86400000)sessions.delete(k);},60000).unref();
buildIndex();
server.listen(Number(process.env.PORT||14160),process.env.HOST||'127.0.0.1',()=>console.log('书店小管家：http://127.0.0.1:'+server.address().port));
