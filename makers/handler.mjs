import { BusinessError } from '../bookshop-store.mjs';
import { execute, runAgent } from '../agent.mjs';
import { searchRules } from './rules.mjs';
import { openStore } from './session-store.mjs';

const busySessions = new Set();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const headers = { 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  return Response.json(body, { status, headers });
}

function invalid(message, status = 400) {
  throw new BusinessError(message, status);
}

function stream(run, signal, release) {
  const cancel = new AbortController();
  const combined = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const emit = (event, data) => {
        if (!combined.aborted) {
          controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
        }
      };
      const heartbeat = setInterval(() => emit('ping', {}), 5000);
      void (async () => {
        try {
          await run(emit, combined);
        } catch (error) {
          if (!combined.aborted) emit('error', { message: error.status ? error.message : '助手暂时无法完成请求' });
        } finally {
          clearInterval(heartbeat);
          try {
            if (!combined.aborted) emit('done', {});
          } finally {
            try { controller.close(); } catch {}
            release();
          }
        }
      })();
    },
    cancel() { cancel.abort(); },
  });
  return new Response(body, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  } });
}

function demoAction(data) {
  if (data.action === 'rules') return ['search_policies', { query: data.query }];
  if (data.action === 'preview') return ['preview_order', { book_id: data.book_id, quantity: data.quantity }];
  return ['search_books', { keyword: data.keyword || '', max_price: data.max_price ?? null }];
}

function modelSettings(env) {
  return { key: env.AI_GATEWAY_API_KEY, base: env.AI_GATEWAY_BASE_URL, model: env.BOOKSHOP_MODEL };
}

export async function handleBookshop(context) {
  const request = context.request;
  const sid = request.headers['makers-conversation-id'];
  if (request.method !== 'POST') return json({ error: '请使用 POST' }, 405);
  if (request.headers['sec-fetch-site'] === 'cross-site') return json({ error: '拒绝跨站请求' }, 403);
  if (!uuid.test(sid || '') || context.conversation_id !== sid) {
    return json({ error: '会话无效，请刷新页面重试' }, 400);
  }
  const input = request.body;
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.path !== 'string'
      || Buffer.byteLength(JSON.stringify(input)) > 16000) return json({ error: '请求无效' }, 400);
  const data = input.data === undefined ? {} : input.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: '请求无效' }, 400);

  const config = modelSettings(context.env || {});
  const live = Boolean(config.key && config.base && config.model);
  if (!input.path.startsWith('/') || input.path.startsWith('//')) return json({ error: '请求无效' }, 400);
  const url = new URL(input.path, 'https://bookshop.invalid');
  if (url.origin !== 'https://bookshop.invalid') return json({ error: '请求无效' }, 400);
  if (url.pathname === '/health') return json({ status: 'ok', live_configured: live });
  if (url.pathname === '/api/rules') {
    try { return json(searchRules(data.query)); }
    catch (error) { return json({ error: error.message }, 400); }
  }
  const state = context.store?.state;
  if (!state) return json({ error: '平台会话存储暂未就绪' }, 503);
  if (busySessions.has(sid)) return json({ error: '上一项操作尚未完成，请稍后重试' }, 409);
  busySessions.add(sid);
  let store;
  let streaming = false;
  const release = () => {
    try { store?.close(); }
    finally { busySessions.delete(sid); }
  };

  try {
    const opened = await openStore(state);
    store = opened.store;
    const persist = opened.persist;
    const session = store.session(sid) || { history: [] };
    switch (url.pathname) {
      case '/api/books':
        return json(store.search());
      case '/api/orders':
        return json(store.orders(sid));
      case '/api/order':
        return json(store.order(sid, url.searchParams.get('id')));
      case '/api/stock':
        return json(store.stockHistory(url.searchParams.get('book_id')));
      case '/api/restock': {
        const movement = store.restock(data);
        if (!movement.replayed) await persist();
        return json(movement);
      }
      case '/api/preview': {
        const quote = Object.hasOwn(data, 'quote_id')
          ? store.reviseQuote(sid, data.quote_id, data.quantity) : store.quote(sid, data);
        await persist();
        return json(quote);
      }
      case '/api/confirm': {
        const order = store.confirm(sid, data.quote_id);
        if (!order.replayed) {
          session.history.push({ role: 'user', content: '用户已在界面确认模拟订单，服务端结果：' + JSON.stringify(order) });
          store.saveSession(sid, session);
          await persist();
        }
        return json(order);
      }
      case '/api/reset':
        store.saveSession(sid, { history: [] });
        await persist();
        return json({ ok: true });
      case '/api/chat': {
        if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 1000) {
          invalid('请输入1至1000字');
        }
        if (!['demo', 'live'].includes(data.mode)) invalid('请选择运行模式');
        if (data.mode === 'live' && !live) invalid('模型模式暂未配置，可使用演示模式', 503);
        const tools = {
          search: args => store.search(args),
          order: (id, orderId) => store.order(id, orderId),
          quote: async (id, args) => {
            const quote = store.quote(id, args);
            await persist();
            return quote;
          },
        };
        const response = stream(async (emit, signal) => {
          if (data.mode === 'demo') {
            const [name, args] = demoAction(data);
            emit('status', { message: '演示模式' });
            emit('tool_start', { name });
            const result = await execute(tools, sid, name, args, searchRules);
            emit('tool_result', { name, result });
            emit('answer', { text: '操作完成，请查看工具结果。' });
          } else {
            const history = await runAgent({
              store: tools, session: sid, message: data.message, history: session.history,
              emit, signal, config, ruleSearch: searchRules,
            });
            signal.throwIfAborted();
            store.saveSession(sid, { history });
            await persist();
          }
        }, request.signal, release);
        streaming = true;
        return response;
      }
      default:
        return json({ error: '接口不存在' }, 404);
    }
  } catch (error) {
    return json({ error: error.status ? error.message : '服务暂时不可用，请稍后重试' }, error.status || 503);
  } finally {
    if (!streaming) release();
  }
}
