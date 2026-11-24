const $=id=>document.getElementById(id);
const state={books:[],orders:[],busy:false,confirming:false,controller:null,view:'overview',messages:[],cart:[],pending:new Map(),scope:null,restoring:false,lastRequest:null};
const money=n=>'¥'+(n/100).toFixed(2), title=s=>s.replace(/^示例：/,''), date=s=>new Date(s).toLocaleString('zh-CN',{hour12:false});
function el(tag,text='',cls=''){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3500)}
function error(e){
  const message=e.message||String(e);
  $('error').replaceChildren(el('span',message+' '+recoveryHint(message)));
  if(state.lastRequest){const retry=el('button','重试本轮','secondary');retry.type='button';retry.onclick=()=>chat(state.lastRequest);$('error').append(retry);}
}
function recoveryHint(message){
 if(/库存不足|库存或价格/.test(message))return '请刷新库存，调整数量后重新生成预览。';
 if(/过期|预览不存在|失效/.test(message))return '请重新生成预览，再核对并确认。';
 if(/模型|HTTP 401|HTTP 429|未配置/.test(message))return '可先切换本地演示，或检查模型配置后重试。';
 if(/fetch|网络|连接|Failed/.test(message))return '请检查服务连接；确认订单失败时，请先查询订单，再重试同一预览。';
 return '可调整条件后重试；已确认的订单请到订单中心核对。';
}
function saveDisplay(){
 if(state.restoring||!state.scope)return;
 try{localStorage.setItem('bookshop-display-v3',JSON.stringify({scope:state.scope,rows:state.messages.slice(-40),cart:state.cart}));}catch{}
}
function remember(row){if(state.restoring)return;state.messages.push(row);state.messages=state.messages.slice(-40);saveDisplay();}
function renderContext(){
 const target=$('active-context');target.replaceChildren();
 const rows=[...state.pending.values()].filter(x=>Date.parse(x.expires_at)>Date.now());
 if(!rows.length){target.append(el('small','当前没有待确认预览。'));return;}
 target.append(el('small',rows.length>1?'有多笔预览，修改时请指明图书或单据。':'当前待确认预览'));
 for(const q of rows.slice(0,3)){const b=el('button',title(q.name)+' · '+q.quantity+' 册 · '+q.quote_id.slice(0,8),'link');b.onclick=()=>{const card=[...$('previews').children].find(x=>x.dataset.quote===q.quote_id)||preview(q);revealOrderWorkflow(card);};target.append(b);}
}
function addCart(book,quantity){
 if(state.busy||state.confirming)return;
 const old=state.cart.find(x=>x.book_id===book.id),count=(old?.quantity||0)+quantity;
 if(!Number.isInteger(quantity)||quantity<1||count>20||count>book.stock){toast('数量须为 1 至 20 册，且不超过可售库存');return;}
 if(!old&&state.cart.length>=10){toast('每笔最多选择 10 种图书');return;}
 if(old)old.quantity=count;else state.cart.push({book_id:book.id,quantity});
 renderCart();saveDisplay();toast('已加入开单清单，可继续选择其他图书');
}
function renderCart(){
 const target=$('cart-items');target.replaceChildren();
 $('cart-count').textContent=state.cart.length?state.cart.length+' 种图书':'尚未选择图书';
 let total=0;
 for(const item of state.cart){const book=state.books.find(b=>b.id===item.book_id);if(!book)continue;total+=book.price_cents*(Number.isInteger(item.quantity)?item.quantity:0);
 const row=el('div','','cart-row'),label=el('label',title(book.name)),input=el('input');input.type='number';input.min='1';input.max='20';input.required=true;input.value=Number.isInteger(item.quantity)?item.quantity:'';input.setAttribute('aria-label',title(book.name)+'清单数量');input.disabled=state.busy||state.confirming;
 input.oninput=()=>{item.quantity=input.valueAsNumber;subtotal.textContent=Number.isInteger(item.quantity)&&item.quantity>=1?money(book.price_cents*item.quantity):'请填写数量';saveDisplay();$('cart-preview').disabled=!state.cart.every(x=>Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20);$('cart-total').textContent='数量已修改，生成预览时重新核价';};
 input.onchange=()=>{if(input.reportValidity())renderCart();};
 const remove=el('button','移除','link');remove.disabled=state.busy||state.confirming;remove.onclick=()=>{state.cart=state.cart.filter(x=>x!==item);saveDisplay();renderCart();};
 const subtotal=el('span',Number.isInteger(item.quantity)&&item.quantity>=1?money(book.price_cents*item.quantity):'请填写数量');
 label.append(input);row.append(label,subtotal,remove);if(item.quantity>book.stock)row.append(el('small','库存不足，请调整数量','error'));target.append(row);}
 if(!state.cart.length)target.append(el('p','在下方找到图书，点击“加入清单”，可将多种图书合并下单。','muted'));
 $('cart-total').textContent=state.cart.length?(state.cart.every(x=>Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20)?'预计合计 '+money(total):'请为每种图书填写有效数量'):'';
 $('cart-preview').disabled=!state.cart.length||state.busy||state.confirming||!state.cart.every(x=>Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20);
}
async function previewCart(items=state.cart,quoteId,previous){
 if(state.busy||state.confirming)return;
 if(!items.length||!items.every(x=>Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20)){$('cart-error').textContent='请为每种图书填写 1 至 20 的整数。';return;}
 const fromDraft=items===state.cart&&!quoteId&&!previous;
 setBusy(true);$('cart-error').textContent='';orderFeedback('正在核对整笔清单…');let card;
 try{const data=await api('/api/preview',{items:items.map(x=>({book_id:x.book_id,quantity:x.quantity})),...(quoteId?{quote_id:quoteId}:{})});card=preview(data,previous||(quoteId?[...$('previews').children].find(x=>x.dataset.quote===quoteId):null));if(fromDraft){state.cart=[];saveDisplay();}orderFeedback('请逐项核对。确认后才会扣减库存。');}
 catch(e){$('cart-error').textContent=e.message+' '+recoveryHint(e.message);orderFeedback(e.message+' '+recoveryHint(e.message),true);}
 finally{setBusy(false);renderCart();revealOrderWorkflow(card);}
}
async function api(path,data){const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const x=await r.json();if(!r.ok)throw Error(x.error||'请求失败');return x;}
function view(name) {
  expandAssistant(false);
  const pages = {
    overview: ['经营概览', '查看库存、缺货提醒和本会话订单。'],
    books: ['图书库存', '按书名、分类、价格或库存筛选图书。'],
    orders: ['订单中心', '查看本会话已确认的模拟订单。'],
    rules: ['门店规则', '查找下单、确认及服务范围的规则原文。'],
  };
  if (!Object.hasOwn(pages, name)) name = 'overview';
  state.view = name;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== 'view-' + name;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const [heading, description] = pages[name];
  $('page-title').textContent = heading;
  $('page-description').textContent = description;
  $('overview-shelf').toggleAttribute('hidden', name !== 'overview');
  history.replaceState(null, '', '#' + name);
}
function expandAssistant(expanded) {
  $('assistant').parentElement.classList.toggle('assistant-expanded', expanded);
  $('expand-assistant').setAttribute('aria-expanded', String(expanded));
  $('expand-assistant').textContent = expanded ? '还原' : '展开';
}
function setAssistant(open, reveal = false) {
  if (!open) expandAssistant(false);
  const panel = $('assistant');
  panel.hidden = !open;
  panel.parentElement.classList.toggle('assistant-closed', !open);
  $('assistant-toggle').setAttribute('aria-expanded', String(open));
  $('assistant-toggle').textContent = open ? '收起助手' : '门店助手';
  if (open && reveal && matchMedia('(max-width: 930px)').matches) panel.scrollIntoView({block:'start'});
}
function empty(target,heading,description){target.replaceChildren();const d=el('div','','empty');d.append(el('b',heading),el('span',description));target.append(d);return d;}
function modal(name,pairs){$('detail-title').textContent=name;const dl=el('dl');for(const [key,value] of pairs)dl.append(el('dt',key),el('dd',String(value)));$('detail-body').replaceChildren(dl);$('detail').showModal();}
function renderStockHistory(target, movements) {
  if (!movements.length) {
    empty(target, '暂无库存流水', '启用流水后的售出与入库会记录在这里。');
    return;
  }
  const wrap = el('div', '', 'table-wrap');
  const table = el('table', '', 'stock-history');
  table.setAttribute('aria-label', '库存流水');
  const header = table.createTHead().insertRow();
  for (const label of ['时间', '变动', '库存前后']) {
    const cell = el('th', label);
    cell.scope = 'col';
    header.append(cell);
  }
  const body = table.createTBody();
  for (const movement of movements) {
    const row = body.insertRow();
    const label = movement.kind === 'restock' ? '到货入库 +' : '订单售出 −';
    row.append(
      el('td', date(movement.created)),
      el('td', label + Math.abs(movement.delta) + ' 册'),
      el('td', movement.stock_before + ' → ' + movement.stock_after + ' 册'),
    );
  }
  wrap.append(table);
  target.replaceChildren(wrap);
}

function bookDetail(book, focusRestock = false) {
  modal(title(book.name), [
    ['编号', book.id], ['作者', book.author], ['分类', book.category],
    ['简介', book.summary], ['模拟售价', money(book.price_cents)], ['资料来源', book.origin],
  ]);
  const panel = el('section', '', 'stock-management');
  const heading = el('div', '', 'section-head');
  const stock = el('span', '可售 ' + book.stock + ' 册', 'stock-badge');
  stock.setAttribute('aria-live', 'polite');
  heading.append(el('h3', '补货入库'), stock);
  const form = el('form', '', 'restock-form');
  const label = el('label', '到货数量（册）');
  const quantity = el('input');
  quantity.type = 'number';
  quantity.min = '1';
  quantity.max = '1000';
  quantity.required = true;
  label.append(quantity);
  const submit = el('button', '确认入库');
  submit.disabled = true;
  form.append(label, submit);
  const notice = el('p', '', 'restock-notice');
  notice.setAttribute('role', 'status');
  const history = el('div', '正在读取流水…');
  history.setAttribute('aria-live', 'polite');
  panel.append(heading, form, notice, el('h3', '库存流水'), history);
  $('detail-body').append(panel);
  if (focusRestock) quantity.focus();

  async function loadHistory() {
    const result = await api('/api/stock?book_id=' + encodeURIComponent(book.id));
    stock.textContent = '可售 ' + result.stock + ' 册';
    renderStockHistory(history, result.movements);
  }

  function historyError() {
    history.textContent = '暂时无法读取库存流水，请重新打开详情。';
  }

  let pending;
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const count = quantity.valueAsNumber;
    if (pending?.quantity !== count) pending = {book_id:book.id, quantity:count, request_id:crypto.randomUUID()};
    submit.disabled = quantity.disabled = $('close-detail').disabled = true;
    notice.classList.remove('error');
    notice.textContent = '正在登记入库…';
    try {
      const result = await api('/api/restock', pending);
      pending = undefined;
      form.reset();
      notice.textContent = result.replayed ? '这笔入库已登记。' : '已入库 ' + count + ' 册。';
      await Promise.all([loadHistory().catch(historyError), refresh().catch(error)]);
    } catch (e) {
      notice.classList.add('error');
      notice.textContent = e.message;
    } finally {
      submit.disabled = quantity.disabled = $('close-detail').disabled = false;
    }
  };
  loadHistory().then(() => { submit.disabled = false; }, historyError);
}
function badge(stock) {
  if (stock === 0) return el('span', '已售罄', 'stock-badge out');
  if (stock <= 2) return el('span', '仅余 ' + stock + ' 册', 'stock-badge low');
  return el('span', stock + ' 册', 'stock-badge');
}

function openStock(bookId, stockFilter = '') {
  $('keyword').value = bookId;
  for (const filter of ['category', 'max-price']) $(filter).value = '';
  $('stock-filter').value = stockFilter;
  view('books');
  renderBooks();
  if (bookId) $('books').querySelector('[data-book-id="' + CSS.escape(bookId) + '"] .book-name')?.focus();
  else $('stock-filter').focus();
}

function renderBooks() {
  const query = $('keyword').value.trim();
  const key = query.toLowerCase();
  const category = $('category').value;
  const maxPrice = $('max-price').value;
  const priceLimit = maxPrice === '' ? null : Math.round(Number(maxPrice) * 100);
  const stockFilter = $('stock-filter');
  const stock = stockFilter.value;
  const stockLabel = stockFilter.selectedOptions[0]?.textContent.trim();
  const keywordMatches = state.books.filter(book =>
    !key || [book.id, book.name, book.author].some(value => String(value ?? '').toLowerCase().includes(key))
  );
  const catalogMatches = keywordMatches.filter(book =>
    (!category || book.category === category) &&
    (priceLimit === null || book.price_cents <= priceLimit)
  );
  const rows = catalogMatches.filter(book =>
    !stock ||
    stock === 'in' && book.stock > 0 ||
    stock === 'restock' && book.stock <= 2 ||
    stock === 'low' && book.stock > 0 && book.stock <= 2 ||
    stock === 'out' && book.stock === 0
  );
  const activeFilters = [
    query && '搜索 ' + query,
    category && '分类 ' + category,
    priceLimit !== null && '最高价 ' + money(priceLimit),
    stock && stockLabel,
  ];
  $('inventory-filters').textContent = activeFilters.filter(Boolean).join(' · ');
  $('book-count').textContent = rows.length + ' 种图书';
  const target = $('books');
  if (!rows.length) {
    if (stock && catalogMatches.length) {
      const heading = stock === 'restock' && !key && !category && priceLimit === null
        ? '暂无待补货图书'
        : '当前库存筛选下没有结果';
      const detail = key
        ? '找到了与「' + query + '」匹配的图书，但它们不符合「' + stockLabel + '」。'
        : '当前书目均不符合「' + stockLabel + '」。';
      const message = empty(target, heading, detail);
      const clear = el('button', '查看全部库存', 'secondary empty-action');
      clear.onclick = () => {
        stockFilter.value = '';
        renderBooks();
        $('keyword').focus();
      };
      message.append(clear);
    } else if (key && keywordMatches.length) {
      empty(target, '当前分类或价格下没有结果', '已找到匹配图书，可以放宽分类或最高价。');
    } else if (stock === 'restock' && !key && !category && priceLimit === null) {
      empty(target, '暂无待补货图书', '可切回「全部库存」查看其他书目。');
    } else empty(target, '未找到图书', '可更换关键词，或重置筛选条件。');
    if(!target.querySelector('button')){const reset=el('button','重置筛选','secondary empty-action');reset.onclick=()=>{$('filters').reset();renderBooks();$('keyword').focus();};target.querySelector('.empty')?.append(reset);}
    return;
  }

  const wrap = el('div', '', 'table-wrap');
  const table = el('table');
  table.setAttribute('aria-label', '图书库存');
  const header = table.createTHead().insertRow();
  for (const label of ['图书', '分类', '售价', '可售库存', '数量 / 操作']) {
    const column = el('th', label);
    column.scope = 'col';
    header.append(column);
  }
  const body = table.createTBody();
  for (const book of rows) {
    const row = body.insertRow();
    row.dataset.bookId = book.id;
    const name = row.insertCell();
    const nameButton = el('button', title(book.name), 'link book-name');
    nameButton.onclick = () => bookDetail(book);
    const metadata = el('small', book.id);
    if (book.author) metadata.append(el('span', ' · ' + book.author, 'book-author'));
    metadata.append(el('span', ' · ' + money(book.price_cents), 'book-compact-price'));
    name.append(nameButton, metadata);
    row.append(el('td', book.category), el('td', money(book.price_cents), 'money-cell'));
    row.insertCell().append(badge(book.stock));

    const actions = el('div', '', 'book-actions');
    const quantity = el('input');
    quantity.type = 'number';
    quantity.value = '1';
    quantity.min = '1';
    quantity.max = '20';
    quantity.required = true;
    quantity.disabled = !book.stock;
    quantity.setAttribute('aria-label', title(book.name) + '的购买数量');
    const button = el('button', '预览订单', 'secondary');
    if (book.stock > 0) button.dataset.orderPreview = '';
    button.disabled = state.busy || state.confirming || !book.stock;
    button.onclick = () => {
      if (!quantity.reportValidity()) return;
      requestOrderPreview(book.id, quantity.valueAsNumber);
    };
    const restock = el('button', '补货', 'link');
    restock.setAttribute('aria-label', '为《' + title(book.name) + '》补货');
    restock.onclick = () => bookDetail(book, true);
    const add=el('button','加入清单','secondary');if(book.stock>0)add.dataset.cartAdd='';add.disabled=state.busy||state.confirming||!book.stock;add.onclick=()=>{if(quantity.reportValidity())addCart(book,quantity.valueAsNumber);};
    actions.append(quantity, button, add, restock);
    row.insertCell().append(actions);
  }
  wrap.append(table);
  target.replaceChildren(wrap);
}
async function orderDetail(id) {
  try {
    const order = await api('/api/order?id=' + encodeURIComponent(id));
    modal('订单详情', [
      ['订单编号', order.id], ['图书', order.name], ['图书编号', order.book_id],
      ['数量', order.quantity + ' 册'], ['合计', money(order.total_cents)],
      ['创建时间', date(order.created)], ['状态', '模拟订单已创建'],
    ]);
    if(order.items){const list=el('ul','','order-lines');for(const item of order.items)list.append(el('li',title(item.name)+' × '+item.quantity+' 册 · '+money(item.total_cents)));$('detail-body').append(list);}
    const stock = el('button', '查看图书库存', 'secondary');
    stock.onclick = () => {
      $('detail').close();
      openStock(order.items ? '' : order.book_id);
    };
    $('detail-body').append(stock);
  } catch (e) {
    toast(e.message);
  }
}

function renderOrderTable(target, orders) {
  if (!orders.length) {
    empty(target, '还没有订单', '从图书库存选择一本书，核对预览后确认创建。');
    return;
  }
  const wrap = el('div', '', 'table-wrap');
  const table = el('table');
  const header = table.createTHead().insertRow();
  for (const label of ['图书 / 订单', '数量', '金额', '状态', '操作']) {
    const column = el('th', label);
    column.scope = 'col';
    header.append(column);
  }
  const body = table.createTBody();
  for (const order of orders) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.append(el('span', title(order.name || order.book_id)), el('small', order.id.slice(0, 8) + ' · ' + date(order.created)));
    row.append(el('td', String(order.quantity)), el('td', money(order.total_cents)));
    row.insertCell().append(el('span', '已创建', 'pill'));
    const detail = el('button', '详情', 'link');
    detail.onclick = () => orderDetail(order.id);
    row.insertCell().append(detail);
  }
  wrap.append(table);
  target.replaceChildren(wrap);
}

function renderOrders() {
  const input = $('order-filter');
  const query = input.value.trim().toLowerCase();
  const orders = state.orders.filter(order =>
    [order.id, order.name || '', order.book_id].some(value => value.toLowerCase().includes(query))
  );
  $('order-count').textContent = orders.length + ' 笔订单';
  const target = $('orders');
  if (query && !orders.length && state.orders.length) {
    const message = empty(target, '没有匹配的订单', '试试订单编号、书名或图书编号。');
    const clear = el('button', '清除搜索', 'secondary empty-action');
    clear.onclick = () => {
      input.value = '';
      renderOrders();
      input.focus();
    };
    message.append(clear);
  } else renderOrderTable(target, orders);
}

function openOrders(orderId = '') {
  $('order-filter').value = orderId;
  view('orders');
  renderOrders();
  $('order-list-title').focus();
}

function render(){renderBooks();renderCart();renderOrders();renderOrderTable($('recent-orders'),state.orders.slice(0,4));const items=[['图书种类',state.books.length,'当前教学书目'],['可售库存',state.books.reduce((n,b)=>n+b.stock,0),'册 · 全部图书'],['模拟订单',state.orders.length,'本浏览器会话'],['模拟订单金额',money(state.orders.reduce((n,o)=>n+o.total_cents,0)),'本会话 · 无真实支付']];$('metrics').replaceChildren();for(const [name,value,note] of items){const d=el('div','','metric');d.append(el('span',name),el('strong',String(value)),el('small',note));$('metrics').append(d);}const cats={};for(const b of state.books)cats[b.category]=(cats[b.category]||0)+b.stock;const max=Math.max(1,...Object.values(cats));$('category-bars').replaceChildren();for(const [name,n]of Object.entries(cats)){const row=el('div','','bar-row'),track=el('div','','bar-track'),fill=el('div','','bar-fill');fill.style.width=(n/max*100)+'%';track.append(fill);row.append(el('span',name),track,el('span',String(n)));$('category-bars').append(row);}$('low-stock').replaceChildren();const low=state.books.filter(b=>b.stock<=2).sort((a,b)=>a.stock-b.stock).slice(0,5);for (const book of low) {
  const row = el('div', '', 'stock-row');
  const link = el('button', title(book.name), 'link');
  link.onclick = () => openStock(book.id);
  row.append(link, badge(book.stock));
  $('low-stock').append(row);
}if(!low.length)empty($('low-stock'),'库存充足','暂无需要留意的图书。');}
async function refresh(){try{const books=await api('/api/books');const orders=await api('/api/orders');state.books=books;state.orders=orders;const selected=$('category').value;$('category').replaceChildren(new Option('全部分类',''));for(const c of [...new Set(books.map(b=>b.category))])$('category').add(new Option(c,c));$('category').value=selected;render();$('notice').hidden=true;}catch(e){$('notice').hidden=false;$('notice').textContent='服务暂时无法连接，请保持启动窗口运行后点击刷新。';throw e;}}
function line(role, text, folded = false) {
  const bubble = el('div', '', 'bubble ' + role);
  if (role === 'assistant') {
    const parts = text.split(/\*\*([^*\n]+)\*\*/);
    parts.forEach((part, index) => bubble.append(index % 2 ? el('strong', part) : part));
    const copy = el('button', '复制回答', 'link copy-answer');
    copy.type = 'button';
    copy.onclick = () => copyAnswer(text);
    bubble.append(copy);
  } else bubble.textContent = text;
  const messages = $('messages');
  if (folded) {
    const reply = el('details', '', 'model-note');
    reply.append(el('summary', '查看模型回复'), bubble);
    messages.append(reply);
  } else messages.append(bubble);
  messages.scrollTop = messages.scrollHeight;
  remember({role,text,folded});
}
function graphStatus(node, text) {
  document.querySelectorAll('[data-node]').forEach(item => {
    item.classList.toggle('active', item.dataset.node === node);
  });
  $('graph-status').textContent = text;
}
function clearSteps() {
  graphStatus('', '等待下一项操作');
  $('steps').replaceChildren();
  $('step-count').textContent = '尚无记录';
}

function step(phase, name, detail = '', failed = false) {
  if(state.restoring)return;
  const steps = $('steps');
  const row = el('li', '', failed ? 'step fail' : 'step');
  row.append(el('span', phase, 'step-phase'), el('b', name));
  if (detail) row.append(el('small', detail));
  steps.append(row);
  $('step-count').textContent = steps.children.length + ' 步';
}
let requestStarted = 0;
let progressTimer;
function progress(message) {
  const output = $('assistant-progress');
  output.hidden = !message;
  output.dataset.message = message;
  output.textContent = message ? message + ' · ' + Math.floor((performance.now() - requestStarted) / 1000) + ' 秒' : '';
}
function copyAnswer(text) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('已复制回答')).catch(() => toast('复制失败，可选中文字复制'));
}
const toolNames={search_books:'查询图书与库存',preview_order:'核对并生成预览',get_order:'查询订单',search_policies:'检索门店规则'};

function orderFeedback(message = '', failed = false) {
  $('order-status').textContent = failed ? '' : message;
  $('order-error').textContent = failed ? message : '';
  if(failed){const retry=el('button','刷新库存','secondary');retry.type='button';retry.onclick=()=>refresh().then(()=>orderFeedback('库存已刷新，请调整数量或重新生成预览。')).catch(e=>orderFeedback(e.message,true));$('order-error').append(retry);}
  $('order-workflow').hidden = !message && !$('previews').childElementCount;
}

function revealOrderWorkflow(receipt) {
  expandAssistant(false);
  const workflow = $('order-workflow');
  if (workflow.hidden) {
    toast('当前没有可核对的单据');
    return;
  }
  const activeReceipt = receipt?.isConnected ? receipt : null;
  (activeReceipt || $('order-workflow-title')).focus({preventScroll:true});
  (activeReceipt || workflow).scrollIntoView({block:activeReceipt ? 'start' : 'nearest'});
}

async function requestOrderPreview(bookId, quantity, previous) {
  if (state.busy || state.confirming) return;
  const fromView = state.view;
  setBusy(true);
  orderFeedback('正在生成订单预览…');
  let receipt;
  try {
    receipt = preview(await api('/api/preview', {book_id:bookId, quantity}),previous);
  } catch (e) {
    orderFeedback(e.message+' '+recoveryHint(e.message), true);
  } finally {
    setBusy(false);
    if (state.view === fromView) revealOrderWorkflow(receipt);
  }
}

function receiptFields(pairs) {
  const fields = el('dl', '', 'receipt-data');
  for (const [label, value] of pairs) {
    const detail = el('dd');
    detail.append(value);
    fields.append(el('dt', label), detail);
  }
  return fields;
}

function receiptHeading(card, title, status) {
  const heading = el('div', '', 'receipt-head');
  const dismiss = el('button', '关闭', 'link receipt-close');
  dismiss.dataset.dismissReceipt = '';
  dismiss.title='收起单据；有效预览可从助手的当前处理单据重新打开';
  dismiss.setAttribute('aria-label', '关闭' + title);
  dismiss.onclick = () => {
    card.remove();
    orderFeedback();
    ($('order-workflow').hidden ? $('page-title') : $('order-workflow-title')).focus({preventScroll:true});
  };
  heading.append(el('h3', title), status, dismiss);
  return heading;
}

function confirmedReceipt(card, order) {
  orderFeedback(order.replayed?'此订单此前已确认，本次未再次扣减库存。':'订单已创建，可查看详情或继续开单。');
  state.pending.delete(card.dataset.quote);renderContext();
  $('previews').querySelector('.confirmed')?.remove();
  const heading = receiptHeading(card, '模拟订单', el('span', '已确认', 'receipt-status'));
  const stock = Number.isInteger(order.stock_before) && Number.isInteger(order.stock_after)
    ? [['库存变动', order.stock_before + ' 册 → ' + order.stock_after + ' 册']]
    : [];
  const fields = receiptFields([['合计', money(order.total_cents)], ...stock]);
  const details = el('button', '查看订单详情', 'link');
  details.onclick = () => orderDetail(order.id);
  const list = el('button', '在订单中心查看', 'secondary');
  list.onclick = () => openOrders(order.id);
  const actions = el('div', '', 'receipt-actions');
  const next=el('button','继续开单','secondary');next.onclick=()=>{openStock('');$('keyword').focus();};
  actions.append(list, details, next);
  delete card.dataset.cartReceipt;
  card.className = 'preview confirmed';
  card.setAttribute('aria-label', '已确认订单 ' + title(order.name));
  card.replaceChildren(
    heading,
    el('p', title(order.name) + ' × ' + order.quantity + ' 册', 'receipt-book'),
    el('strong', '订单编号 ' + order.id, 'order-number'),
    fields,
    el('small', order.replayed ? '此订单此前已确认，本次未再次扣减库存。' : '模拟订单，未发生支付。'),
    actions,
  );
  if(order.items){const changes=el('ul','','order-lines');for(const x of order.items)changes.append(el('li',title(x.name)+' × '+x.quantity+' 册 · '+money(x.total_cents)+(Number.isInteger(x.stock_before)?' · 库存 '+x.stock_before+' → '+x.stock_after:'')));card.insertBefore(changes,actions);}
}

function updateConfirmButtons() {
  const busy = state.busy || state.confirming;
  $('cart-preview').disabled=busy||!state.cart.length||!state.cart.every(x=>Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20);
  for(const card of $('previews').querySelectorAll('[data-cart-receipt]'))card.updateControls(busy);
  $('clear-chat').disabled = busy;
  $('send').disabled = busy;
  for (const button of document.querySelectorAll('[data-order-preview], [data-cart-add]')) {
    button.disabled = busy;
  }
  for (const button of $('previews').querySelectorAll('[data-dismiss-receipt]')) {
    button.disabled = busy;
  }
  for (const form of $('previews').querySelectorAll('[data-preview-form]')) {
    const quantity = form.elements.quantity;
    const changed = quantity.valueAsNumber !== Number(form.dataset.previewForm);
    const blocked = busy || form.closest('.preview').classList.contains('expired');
    quantity.disabled = blocked;
    form.querySelector('[data-revise]').disabled = blocked || !changed || !quantity.validity.valid;
    form.querySelector('[data-confirm]').disabled = blocked || changed;
  }
}

function preview(quote, previous) {
  if(quote.items)return cartReceipt(quote,previous);
  if(quote.replaces_quote_id)state.pending.delete(quote.replaces_quote_id);
  state.pending.set(quote.quote_id,quote);renderContext();
  const previews = $('previews');
  const existing = [...previews.children].find(card => card.dataset.quote === quote.quote_id);
  if (existing) return existing;
  const card = el('article', '', 'preview');
  card.dataset.quote = quote.quote_id;
  card.tabIndex = -1;
  card.setAttribute('aria-label', '订单预览 ' + title(quote.name));
  const status = el('span', '待确认', 'receipt-status');
  const heading = receiptHeading(card, '订单预览', status);
  const unitPrice = quote.unit_price_cents ?? quote.total_cents / quote.quantity;
  const stock = Number.isInteger(quote.stock_at_preview)
    ? [['核对时库存', quote.stock_at_preview + ' 册']]
    : [];
  const form = el('form');
  form.dataset.previewForm = String(quote.quantity);
  const quantity = el('input', '', 'receipt-quantity');
  quantity.name = 'quantity';
  quantity.type = 'number';
  quantity.min = '1';
  quantity.max = '20';
  quantity.value = String(quote.quantity);
  quantity.required = true;
  quantity.setAttribute('aria-label', title(quote.name) + '的预览数量');
  const fields = receiptFields([
    ['数量（册）', quantity],
    ['单价', money(unitPrice)],
    ...stock,
    ['合计', money(quote.total_cents)],
  ]);
  const expires = new Date(quote.expires_at);
  const tip = el('small', '有效至 ' + expires.toLocaleTimeString('zh-CN', {hour12:false}) + '。确认后扣减库存。');
  const changeNote = el('small', '', 'receipt-change-note');
  changeNote.setAttribute('role', 'status');
  const revise = el('button', '更新预览', 'secondary');
  revise.type = 'submit';
  revise.dataset.revise = '';
  const button = el('button', '确认创建订单');
  button.type = 'button';
  button.dataset.confirm = '';

  const renewal=el('button','重新生成预览','secondary');renewal.type='button';renewal.hidden=true;renewal.onclick=()=>requestOrderPreview(quote.book_id,quote.quantity,card);
  const invalidate = (label, message) => {
    card.classList.add('expired');
    status.textContent = label;
    tip.textContent = message;
    changeNote.textContent = '';
    button.textContent = '请重新预览';
    updateConfirmButtons();
    clearInterval(timer);
    state.pending.delete(quote.quote_id);renderContext();
    renewal.hidden=false;
  };
  const checkExpiry = () => {
    if (!card.isConnected) clearInterval(timer);
    else if (Date.now() >= expires.getTime()) invalidate('已过期', '请重新生成订单预览。');
  };
  const timer = setInterval(checkExpiry, 1000);
  quantity.oninput = () => {
    if (quantity.valueAsNumber === quote.quantity) changeNote.textContent = '';
    else changeNote.textContent = quantity.validity.valid ? '数量已修改。更新预览后可确认。' : '请输入 1 至 20 的整数。';
    updateConfirmButtons();
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (revise.disabled) return;
    setBusy(true);
    orderFeedback('正在更新订单预览…');
    let updated;
    try {
      const revised = await api('/api/preview', {quote_id:quote.quote_id, quantity:quantity.valueAsNumber});
      clearInterval(timer);
      updated = preview(revised, card);
      orderFeedback('预览已更新，请核对数量和金额。');
    } catch (e) {
      orderFeedback(e.message+' '+recoveryHint(e.message), true);
      if (e.message.includes('过期')) invalidate('已过期', e.message);
      else if (e.message.includes('预览不存在') || e.message.includes('订单已确认')) invalidate('已失效', e.message);
    } finally {
      setBusy(false);
      updated?.querySelector('.receipt-quantity').focus();
    }
  };
  button.onclick = async () => {
    if (button.disabled) return;
    state.confirming = true;
    updateConfirmButtons();
    button.textContent = '正在确认…';
    orderFeedback();
    try {
      const order = await api('/api/confirm', {quote_id:quote.quote_id});
      clearInterval(timer);
      confirmedReceipt(card, order);
      await refresh().catch(e => orderFeedback(e.message, true));
      toast(order.replayed ? '订单已确认' : '订单已创建，库存已更新');
    } catch (e) {
      orderFeedback(e.message+' '+recoveryHint(e.message), true);
      if (e.message.includes('过期')) invalidate('已过期', e.message);
      else if (e.message.includes('变化') || e.message.includes('预览不存在')) invalidate('已失效', e.message);
      else if (!card.classList.contains('expired')) button.textContent = '确认创建订单';
    } finally {
      state.confirming = false;
      updateConfirmButtons();renderCart();
    }
  };
  const actions = el('div', '', 'receipt-actions');
  actions.append(revise, button);
  form.append(fields, tip, changeNote, actions, renewal);
  card.append(heading, el('p', title(quote.name), 'receipt-book'), el('small', quote.book_id), form);
  if (previous) previous.replaceWith(card);
  else previews.prepend(card);
  orderFeedback();
  checkExpiry();
  updateConfirmButtons();
  return card;
}
function cartReceipt(quote, previous) {
  const existing=[...$('previews').children].find(x=>x.dataset.quote===quote.quote_id);
  if(existing)return existing;
  if(quote.replaces_quote_id)state.pending.delete(quote.replaces_quote_id);
  state.pending.set(quote.quote_id,quote);renderContext();
  const card=el('article','','preview cart-receipt');
  card.dataset.quote=quote.quote_id;card.dataset.cartReceipt='';card.tabIndex=-1;
  card.setAttribute('aria-label','合并订单预览');
  const status=el('span','待确认','receipt-status'),list=el('div','','cart-preview-lines');
  const edited=quote.items.map(x=>({book_id:x.book_id,quantity:x.quantity}));
  const inputs=[];
  const revise=el('button','更新整笔预览','secondary');
  const confirm=el('button','确认创建合并订单');
  const expires=Date.parse(quote.expires_at);
  const originalTotal=quote.items.length+' 种 · '+quote.quantity+' 册 · 合计 '+money(quote.total_cents);
  const total=el('strong',originalTotal);
  const note=el('p','有效至 '+new Date(expires).toLocaleTimeString('zh-CN',{hour12:false})+'。确认后才会扣库存。');
  for(const [i,item] of quote.items.entries()){
    const row=el('label',title(item.name)+' · '+money(item.unit_price_cents)+' / 册');
    const input=el('input');input.type='number';input.min='1';input.max='20';input.required=true;input.value=item.quantity;
    input.setAttribute('aria-label',title(item.name)+'合并预览数量');
    input.oninput=()=>{edited[i].quantity=input.valueAsNumber;card.updateControls(state.busy||state.confirming);};
    inputs.push(input);
    row.append(input,el('span','预览小计 '+money(item.total_cents)+' · 核对时库存 '+item.stock_at_preview));list.append(row);
  }
  const renew=el('button','重新生成整笔预览','secondary');renew.hidden=true;
  renew.onclick=()=>previewCart(edited,undefined,card);
  card.updateControls=busy=>{
    const expired=card.classList.contains('expired');
    const changed=edited.some((x,i)=>x.quantity!==quote.items[i].quantity);
    const valid=edited.every(x=>Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20);
    for(const input of inputs)input.disabled=busy;
    revise.disabled=busy||expired||!changed||!valid;
    confirm.disabled=busy||expired||changed||!valid;
    renew.disabled=busy||!valid;
    total.textContent=changed?'原预览合计 '+money(quote.total_cents)+' · 数量已修改，请更新整笔预览':originalTotal;
  };
  const invalidate=message=>{
    card.classList.add('expired');status.textContent='已失效';
    note.textContent=message||'预览已失效，请重新核对整笔清单。';
    renew.hidden=false;state.pending.delete(quote.quote_id);renderContext();
    card.updateControls(state.busy||state.confirming);
  };
  const timer=setInterval(()=>{
    if(!card.isConnected){clearInterval(timer);return;}
    if(Date.now()>=expires){invalidate('预览已过期，请重新核对整笔清单。');clearInterval(timer);}
  },1000);
  revise.onclick=()=>{if(!revise.disabled)previewCart(edited,quote.quote_id);};
  confirm.onclick=async()=>{
    if(confirm.disabled||state.busy||state.confirming)return;
    state.confirming=true;updateConfirmButtons();
    try{
      const order=await api('/api/confirm',{quote_id:quote.quote_id});
      clearInterval(timer);confirmedReceipt(card,order);
      await refresh().catch(()=>orderFeedback('订单已创建，但列表刷新失败。请点击刷新数据核对，勿另建订单重复购买。'));
      toast(order.replayed?'此订单已确认，本次未重复扣库存':'整笔订单已创建，各项库存已更新');
    }catch(e){
      orderFeedback(e.message+' '+recoveryHint(e.message),true);
      if(/变化|过期|不存在|整笔/.test(e.message))invalidate(e.message);
    }finally{state.confirming=false;updateConfirmButtons();renderCart();}
  };
  const actions=el('div','','receipt-actions');actions.append(revise,confirm,renew);
  card.append(receiptHeading(card,'合并订单预览',status),list,total,note,actions);
  if(previous)previous.replaceWith(card);else $('previews').prepend(card);
  orderFeedback();updateConfirmButtons();
  if(Date.now()>=expires)invalidate('预览已过期，请重新核对整笔清单。');
  return card;
}
function result(name, data) {
  remember({role:'tool',name,data});
  if (data?.error) {
    step('返回结果', toolNames[name] || '工具执行失败', data.error, true);
    line('label',data.error+' '+recoveryHint(data.error));
    return false;
  }
  const messages = $('messages');
  const card = el('div', '', 'tool-result');
  if (name === 'preview_order' && data?.quote_id) {
    step('返回结果', toolNames[name], '预览 ' + data.quantity + ' 册，合计 ' + money(data.total_cents) + '，待店员确认');
    const previous = data.replaces_quote_id
      ? [...$('previews').children].find(card => card.dataset.quote === data.replaces_quote_id) : null;
    const receipt = preview(data, previous);
    const review = el('button', '核对订单预览', 'link receipt-jump');
    review.onclick = () => revealOrderWorkflow(receipt);
    messages.append(review);
    messages.scrollTop = messages.scrollHeight;
    return true;
  }
  if (name === 'search_books') {
    step('返回结果', toolNames[name], '找到 ' + data.length + ' 种图书');
    card.append(el('h3', '库存查询 · ' + data.length + ' 种'));
    if (!data.length){card.append(el('p','没有符合条件的图书。可以放宽预算或查看全部书目。'));const all=el('button','查看全部图书','secondary');all.onclick=()=>openStock('');card.append(all);}
    else {
      const list = el('ul', '', 'result-books');
      for (const book of data.slice(0, 5)) {
        const row = el('li');
        const bookButton = el('button', title(book.name), 'link');
        bookButton.onclick = () => bookDetail(book);
        const meta = el('span', book.id + ' · ' + money(book.price_cents));
        const actions = el('form', '', 'book-card-actions');
        const quantity = document.createElement('input');
        quantity.type = 'number';
        quantity.min = '1';
        quantity.max = String(Math.min(20, book.stock));
        quantity.value = '1';
        quantity.required = true;
        quantity.setAttribute('aria-label', title(book.name) + '购买数量');
        const buy = el('button', '生成预览', 'secondary');
        buy.type = 'submit';
        buy.disabled = book.stock < 1;
        quantity.disabled = book.stock < 1;
        actions.append(quantity, el('span', '册'), buy);
        actions.onsubmit = event => {
          event.preventDefault();
          if (actions.reportValidity()) requestOrderPreview(book.id, quantity.valueAsNumber);
        };
        const available = badge(book.stock);
        row.append(bookButton, meta, available, actions);
        list.append(row);
      }
      card.append(list);
      if (data.length > 5) card.append(el('small', '显示前 5 项'));
    }
    const button = el('button', '打开库存页', 'link');
    button.onclick = () => view('books');
    card.append(button);
    messages.append(card);
  } else if (name === 'get_order') {
    step('返回结果', toolNames[name], '已查到本会话订单');
    card.append(el('h3', '订单 ' + data.id.slice(0, 8)), el('p', title(data.name) + ' × ' + data.quantity), el('strong', money(data.total_cents)));
    const details = el('button', '查看订单详情', 'secondary');
    details.onclick = () => orderDetail(data.id);
    card.append(details);
    messages.append(card);
  } else if (name === 'search_policies') {
    step('返回结果', toolNames[name], '找到 ' + data.length + ' 个原文片段');
    if (!data.length) {
      line('assistant', '没有找到对应规则，可换个关键词。');
      return true;
    }
    for (const row of data) {
      const source = el('details', '', 'tool-result citation');
      source.append(el('summary', row.source + ' · 查看原文'), el('p', row.excerpt));
      messages.append(source);
    }
  }
  messages.scrollTop = messages.scrollHeight;
  return name === 'search_books';
}
function setBusy(busy) {
  state.busy = busy;
  $('send').textContent = busy ? '处理中…' : '发送';
  $('mode').disabled = busy;
  $('cancel').hidden = !busy || !state.controller;
  updateConfirmButtons();
  renderCart();
}

async function chat(data) {
  if (state.busy || state.confirming) return;
  state.controller = new AbortController();
  requestStarted = performance.now();
  progress('正在处理');
  progressTimer = setInterval(() => progress($('assistant-progress').dataset.message), 1000);
  state.lastRequest={...data};
  setBusy(true);
  $('error').textContent = '';
  clearSteps();
  line('user', data.message);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(data),
      signal: state.controller.signal,
    });
    if (!response.ok) {
      const body = await response.json();
      throw Error(body.error || '请求失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    let shownResult = false;
    let shownPreview = false;
    while (true) {
      const {value, done} = await reader.read();
      buffer += decoder.decode(value, {stream:!done});
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const payload = /^data: (.+)$/m.exec(block)?.[1];
        if (!payload) continue;
        const item = JSON.parse(payload);
        if (event === 'answer') {
          progress('正在整理结果');
          if (data.mode !== 'demo' || !shownResult) line('assistant', item.text, shownPreview);
        } else if (event === 'error') {
          error(Error(item.message));
          step('请求失败', '本轮未完成', item.message, true);
        } else if (event === 'status' && data.mode === 'demo') {
          step('处理请求', '本地演示', '按页面选择的操作执行');
        } else if (event === 'status' && item.node === 'request_model') {
          progress(item.round === 1 ? '正在理解需求' : '正在整理工具结果');
          graphStatus('request_model', '模型请求 ' + item.round + '/4 · 已调用工具 ' + (item.calls || 0) + '/6');
          step('处理请求', item.round === 1 ? '模型判断所需操作' : '模型读取工具结果');
        } else if (event === 'status' && item.node === 'execute_tools') {
          graphStatus('execute_tools', '正在校验并执行工具');
        } else if (event === 'status' && item.node === 'limit') {
          graphStatus('limit', '已达到本轮调用上限');
        } else if (event === 'tool_start') {
          progress(toolNames[item.name] || '正在执行操作');
          graphStatus(data.mode === 'live' ? 'execute_tools' : '', data.mode === 'live' ? '正在调用工具 ' + item.call + '/6' : '按快捷操作执行');
          step('调用工具', toolNames[item.name] || '运行业务工具');
        }
        else if (event === 'tool_result') {
          const displayed = result(item.name, item.result);
          shownResult ||= displayed;
          shownPreview ||= displayed && item.name === 'preview_order';
        } else if (event === 'done') {
          completed = true;
          if (!$('error').textContent) graphStatus('', '本轮处理完成');
        }
      }
      if (done) break;
    }
    if (!completed) throw Error('连接中断，本轮可能未完成，请核对结果后重试。');
  } catch (e) {
    if (e.name === 'AbortError') {
      graphStatus('', '本轮已停止');
      line('label', '本轮请求已停止。已生成的预览和确认过的订单仍保留。');
      step('请求停止', '用户停止本轮请求');
    } else {
      error(e);
      step('请求失败', '本轮未完成', e.message, true);
    }
  } finally {
    clearInterval(progressTimer);
    const elapsed = Math.floor((performance.now() - requestStarted) / 1000);
    const output = $('assistant-progress');
    output.hidden = false;
    output.textContent = ($('error').textContent ? '本轮未完成' : state.controller.signal.aborted ? '已停止' : '已完成') + ' · ' + elapsed + ' 秒';
    state.controller = null;
    setBusy(false);
    await refresh().catch(error);
  }
}
async function rules(query){$('rule-query').value=query;$('rule-results').textContent='正在检索…';try{const rows=await api('/api/rules',{query});$('rule-results').replaceChildren();if(!rows.length){empty($('rule-results'),'未找到对应规则','请换一种问法；未收录的政策不会推测。');return;}for(const row of rows){const d=el('article','','source-card');d.append(el('b',row.source),el('small',' · 片段 '+row.chunk+' · 教学规则原文'),el('p',row.excerpt));$('rule-results').append(d);}}catch(e){$('rule-results').textContent=e.message;}}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => view(button.dataset.view);
for (const button of document.querySelectorAll('[data-go]')) {
  button.onclick = () => {
    view(button.dataset.go);
    $('page-title').focus();
  };
}
for (const button of document.querySelectorAll('[data-restock-list]')) button.onclick = () => openStock('', 'restock');
for (const button of document.querySelectorAll('[data-all-orders]')) button.onclick = () => openOrders();
for (const button of document.querySelectorAll('[data-rule]')) button.onclick = () => rules(button.dataset.rule);
$('filters').oninput=renderBooks;$('filters').onsubmit=e=>e.preventDefault();$('filters').onreset=()=>setTimeout(renderBooks,0);$('order-filter').oninput=renderOrders;$('refresh').onclick=()=>refresh().then(()=>state.scope?null:restoreWorkspace()).then(()=>toast('数据已更新')).catch(error);$('close-detail').onclick=()=>$('detail').close();$('detail').onclick=e=>{if(e.target===$('detail')&&!$('close-detail').disabled)$('detail').close()};
$('detail').addEventListener('cancel', e => { if ($('close-detail').disabled) e.preventDefault(); });$('rules-form').onsubmit=e=>{e.preventDefault();rules($('rule-query').value.trim())};$('cancel').onclick=()=>state.controller?.abort();
$('chat-form').onsubmit=e=>{e.preventDefault();const message=$('message').value.trim();if(!message||state.busy||state.confirming)return;if($('mode').value==='demo'){error(Error('本地演示请使用快捷查询，或到库存页预览订单。自由提问需切换到 Agnes 模型。'));return;}chat({mode:'live',message});$('message').value='';};$('message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}};
for (const button of document.querySelectorAll('[data-prompt]')) {
  button.onclick = () => {
    const message = button.dataset.prompt;
    if ($('mode').value === 'live') {
      chat({mode:'live', message});
    } else if (message.includes('数据库')) {
      view('books');
      $('keyword').value = '数据库';
      $('max-price').value = '50';
      renderBooks();
      chat({mode:'demo', message, keyword:'数据库', max_price:50});
    } else {
      chat({mode:'demo', message, action:'rules', query:'订单预览五分钟有效'});
    }
  };
}
$('mode').onchange=()=>{$('mode-hint').textContent=$('mode').value==='demo'?'演示模式请使用上方快捷查询':'Agnes 请求计入账户用量';};
$('clear-chat').onclick=async()=>{
  try {
    await api('/api/reset',{});
    state.messages=[];
    saveDisplay();
    $('error').textContent='';state.lastRequest=null;
    $('messages').replaceChildren();
    clearSteps();
    line('label','聊天已清空，本会话订单仍保留。');
  } catch(e) { error(e); }
};
async function restoreWorkspace(){
 const workspace=await api('/api/workspace');state.scope=workspace.scope;
 let saved;try{saved=JSON.parse(localStorage.getItem('bookshop-display-v3')||'null');}catch{}
 const rows=saved?.scope===state.scope&&Array.isArray(saved.rows)?saved.rows.slice(-40).filter(x=>!(x?.role==='label'&&x.text?.startsWith('已核对服务器并恢复预览'))):[];
 if(saved?.scope===state.scope&&Array.isArray(saved.cart))state.cart=saved.cart.filter(x=>state.books.some(b=>b.id===x.book_id)&&Number.isInteger(x.quantity)&&x.quantity>=1&&x.quantity<=20).slice(0,10);
 state.restoring=true;state.messages=rows;
 for(const q of workspace.previews)preview(q);
 for(const row of rows){
  if(['user','assistant','label'].includes(row?.role)&&typeof row.text==='string')line(row.role,row.text,row.folded===true);
  else if(row?.role==='tool'&&row.data){
   if(row.name==='search_books'&&Array.isArray(row.data))result(row.name,row.data.map(old=>state.books.find(x=>x.id===old.id)).filter(Boolean));
   else if(row.name==='get_order'){const current=state.orders.find(x=>x.id===row.data.id);if(current)result(row.name,current);}
   else if(row.name==='search_policies'&&Array.isArray(row.data))result(row.name,row.data);
   else if(row.name==='preview_order'){const q=workspace.previews.find(x=>x.quote_id===row.data.quote_id);if(q)result(row.name,q);else line('label','此前预览已确认或失效，请到订单中心核对。');}
  }
 }
 state.restoring=false;
 if(!rows.length)line('assistant','可以查询图书、核对库存或预览订单。确认订单后才会扣减库存。');
 if(workspace.previews.length){state.restoring=true;line('label','已核对服务器并恢复预览；过期单据需要重新生成。');state.restoring=false;}
 renderContext();renderCart();clearSteps();saveDisplay();
}
$('cart-preview').onclick=()=>previewCart();
$('expand-assistant').onclick=()=>expandAssistant($('expand-assistant').getAttribute('aria-expanded')!=='true');
$('assistant-toggle').onclick=()=>setAssistant($('assistant').hidden,true);
view(location.hash.slice(1)||'overview');refresh().then(restoreWorkspace).catch(error);api('/health').then(h=>{$('model-status').textContent=h.live_configured?'已读取模型配置':'未配置模型，可使用本地演示';$('mode').querySelector('[value=live]').disabled=!h.live_configured;}).catch(error);
