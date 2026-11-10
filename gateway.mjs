import {generateText,jsonSchema,tool} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
export function coreMessages(messages){return messages.map(m=>{
 if(m.role==='tool')return {role:'tool',content:[{type:'tool-result',toolCallId:m.tool_call_id,toolName:m.name,output:{type:'json',value:JSON.parse(m.content)}}]};
 if(m.role==='assistant'&&m.tool_calls?.length)return {role:'assistant',content:[...(m.content?[{type:'text',text:m.content}]:[]),...m.tool_calls.map(c=>({type:'tool-call',toolCallId:c.id,toolName:c.function.name,input:JSON.parse(c.function.arguments)}))]};
 return {role:m.role,content:m.content};
});}
export async function requestModel({config,messages,tools,fetcher,transport='sdk',signal}){
 const base=config.base.replace(/\/$/,'');
 if(transport==='sdk'){
  const provider=createOpenAI({apiKey:config.key,baseURL:base,fetch:fetcher});
  const registry=Object.fromEntries(tools.map(t=>[t.function.name,tool({description:t.function.description,inputSchema:jsonSchema(t.function.parameters)})]));
  const r=await generateText({model:provider.chat(config.model),instructions:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:coreMessages(messages.filter(m=>m.role!=='system')),tools:registry,maxOutputTokens:700,maxRetries:0,abortSignal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});
  return {role:'assistant',content:r.text||null,tool_calls:r.toolCalls?.length?r.toolCalls.map(c=>({id:c.toolCallId,type:'function',function:{name:c.toolName,arguments:JSON.stringify(c.input)}})):undefined};
 }
 const r=await (fetcher||fetch)(base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`},body:JSON.stringify({model:config.model,messages,tools,tool_choice:'auto',stream:false,max_tokens:700}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});
 if(!r.ok)throw new Error(`模型服务返回 HTTP ${r.status}，请检查权限、限流或配置`);
 const raw=await r.json();const m=raw.choices?.[0]?.message;if(!m)throw new Error('模型响应缺少消息');return m;
}
export async function relayOpenAI({body,config,response,fetcher=fetch}){
 if(!config.key||!config.model)throw new Error('模型未配置');
 if(body.model!==config.model)throw new Error('只能使用已配置的模型');
 if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>80)throw new Error('messages无效或过长');
 const stream=body.stream===true;
 const upstream=await fetcher(config.base.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`},body:JSON.stringify({...body,max_tokens:Math.min(Number.isInteger(body.max_tokens)&&body.max_tokens>0?body.max_tokens:700,1500)}),signal:AbortSignal.timeout(60000)});
 if(!upstream.ok)throw new Error(`上游HTTP ${upstream.status}`);
 if(stream){if(!upstream.headers.get('content-type')?.includes('text/event-stream'))throw new Error('上游未返回SSE');response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'});for await(const chunk of upstream.body){if(response.destroyed)break;if(!response.write(chunk))await new Promise(resolve=>response.once('drain',resolve));}response.end();}
 else {const result=await upstream.json();response.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(result));}
}
