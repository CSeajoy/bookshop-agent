import { randomUUID } from 'node:crypto';
export class BusinessError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const check=(condition,message,status=400)=>{if(!condition)throw new BusinessError(message,status);};
export class BookshopStore {
 constructor(db,seed){
  this.db=db;this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,name TEXT NOT NULL,author TEXT,price INTEGER NOT NULL CHECK(price>=0),stock INTEGER NOT NULL CHECK(stock>=0));
   CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,session TEXT NOT NULL,book TEXT NOT NULL REFERENCES books(id),quantity INTEGER NOT NULL,total INTEGER NOT NULL,created TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,session TEXT NOT NULL,book TEXT NOT NULL REFERENCES books(id),quantity INTEGER NOT NULL,price INTEGER NOT NULL,expires INTEGER NOT NULL,order_id TEXT REFERENCES orders(id));`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS book_details(id TEXT PRIMARY KEY REFERENCES books(id),category TEXT NOT NULL,summary TEXT NOT NULL,origin TEXT NOT NULL,accent TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,history TEXT NOT NULL,expires INTEGER NOT NULL);`);
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS stock_movements(
    id INTEGER PRIMARY KEY,
    book TEXT NOT NULL REFERENCES books(id),
    kind TEXT NOT NULL CHECK(kind IN ('sale','restock')),
    delta INTEGER NOT NULL CHECK(delta<>0),
    stock_before INTEGER NOT NULL CHECK(stock_before>=0),
    stock_after INTEGER NOT NULL CHECK(stock_after>=0 AND stock_after=stock_before+delta),
    created TEXT NOT NULL,
    order_id TEXT UNIQUE REFERENCES orders(id),
    restock_key TEXT UNIQUE
   );
   CREATE INDEX IF NOT EXISTS stock_movements_by_book ON stock_movements(book,id DESC);
  `);
  this.db.exec(`CREATE TABLE IF NOT EXISTS cart_quotes(id TEXT PRIMARY KEY,session TEXT NOT NULL,quotes TEXT NOT NULL,expires INTEGER NOT NULL,order_id TEXT); CREATE TABLE IF NOT EXISTS cart_orders(id TEXT PRIMARY KEY,session TEXT NOT NULL,children TEXT NOT NULL,created TEXT NOT NULL);`);
  const details=this.db.prepare('INSERT INTO book_details VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET category=excluded.category,summary=excluded.summary,origin=excluded.origin,accent=excluded.accent');
  const insert=this.db.prepare('INSERT OR IGNORE INTO books VALUES(?,?,?,?,?)');
  for(const b of seed){insert.run(b.id,b.name,b.author,b.priceCents,b.stock);details.run(b.id,b.category||'未分类',b.summary||'',b.origin||'教学示例',b.accent||'#456451');}
 }
 search({keyword='',max_price=null}={}){
  check(typeof keyword==='string'&&keyword.length<=100,'关键词过长或无效');
  check(max_price===null||(typeof max_price==='number'&&Number.isFinite(max_price)&&max_price>=0),'价格须为非负数字');
  return this.db.prepare('SELECT b.id,b.name,b.author,b.price AS price_cents,b.stock,d.category,d.summary,d.origin,d.accent FROM books b JOIN book_details d ON d.id=b.id WHERE (instr(b.name,?)>0 OR instr(b.author,?)>0 OR instr(b.id,?)>0) AND (? IS NULL OR b.price<=?) ORDER BY b.id LIMIT 100').all(keyword,keyword,keyword,max_price,max_price===null?null:Math.round(max_price*100));
 }
 stockHistory(bookId){
  check(typeof bookId==='string'&&bookId,'缺少图书编号');
  const rows=this.db.prepare(`
   SELECT b.stock,m.id,m.kind,m.delta,m.stock_before,m.stock_after,m.created
   FROM books b LEFT JOIN stock_movements m ON m.book=b.id
   WHERE b.id=? ORDER BY m.id DESC LIMIT 50
  `).all(bookId);
  check(rows.length,'图书不存在',404);
  return {
   book_id:bookId,
   stock:rows[0].stock,
   movements:rows.filter(row=>row.id!==null).map(({stock,...movement})=>movement),
  };
 }
 recordMovement({bookId,kind,delta,stockAfter,created,orderId=null,restockKey=null}){
  return this.db.prepare(`
   INSERT INTO stock_movements(book,kind,delta,stock_before,stock_after,created,order_id,restock_key)
   VALUES(?,?,?,?,?,?,?,?) RETURNING id,kind,delta,stock_before,stock_after,created
  `).get(bookId,kind,delta,stockAfter-delta,stockAfter,created,orderId,restockKey);
 }
 restock({book_id,quantity,request_id}){
  check(typeof book_id==='string'&&book_id,'缺少图书编号');
  check(Number.isInteger(quantity)&&quantity>=1&&quantity<=1000,'入库数量须为 1 至 1000 的整数');
  check(typeof request_id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request_id),'入库请求编号无效');
  const key=request_id.toLowerCase();
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const existing=this.db.prepare(`
    SELECT book,id,kind,delta,stock_before,stock_after,created FROM stock_movements WHERE restock_key=?
   `).get(key);
   if(existing){
    const {book,...movement}=existing;
    check(book===book_id&&movement.delta===quantity,'同一入库请求编号已用于另一笔操作',409);
    this.db.exec('COMMIT');
    return {...movement,replayed:true};
   }
   const updated=this.db.prepare('UPDATE books SET stock=stock+? WHERE id=? RETURNING stock').get(quantity,book_id);
   check(updated,'图书不存在',404);
   const movement=this.recordMovement({bookId:book_id,kind:'restock',delta:quantity,stockAfter:updated.stock,created:new Date().toISOString(),restockKey:key});
   this.db.exec('COMMIT');
   return movement;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 quote(session,args){
  if(args.items!==undefined)return this.quoteCart(session,args.items);
  const {book_id,quantity}=args;
  check(typeof book_id==='string','缺少图书编号');check(Number.isInteger(quantity)&&quantity>0&&quantity<=20,'数量须为1至20的整数');
  const b=this.db.prepare('SELECT * FROM books WHERE id=?').get(book_id);check(b,'图书不存在',404);check(b.stock>=quantity,'库存不足',409);
  const id=randomUUID(),expires=Date.now()+300000;
  this.db.prepare('INSERT INTO quotes VALUES(?,?,?,?,?,?,NULL)').run(id,session,b.id,quantity,b.price,expires);
  return {quote_id:id,book_id:b.id,name:b.name,quantity,unit_price_cents:b.price,stock_at_preview:b.stock,total_cents:b.price*quantity,expires_at:new Date(expires).toISOString(),requires_user_confirmation:true};
 }
 reviseQuote(session,id,quantity){
  if(this.db.prepare('SELECT id FROM cart_quotes WHERE id=? AND session=?').get(id,session))return this.reviseCart(session,id,quantity);
  check(typeof id==='string','缺少预览编号');
  check(!this.db.prepare('SELECT id FROM cart_quotes WHERE session=? AND instr(quotes,?)>0').get(session,id),'请通过合并预览修改整笔订单',409);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const existing=this.db.prepare('SELECT book,expires,order_id FROM quotes WHERE id=? AND session=?').get(id,session);
   check(existing,'预览不存在',404);
   check(!existing.order_id,'订单已确认，请另建预览',409);
   check(existing.expires>=Date.now(),'预览已过期，请重新预览',409);
   const revised=this.quote(session,{book_id:existing.book,quantity});
   this.db.prepare('DELETE FROM quotes WHERE id=?').run(id);
   this.db.exec('COMMIT');
   return {...revised,replaces_quote_id:id};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 confirm(session,id,internal=false){
  check(typeof id==='string','缺少预览编号');
  if(!internal&&this.db.prepare('SELECT id FROM cart_quotes WHERE id=? AND session=?').get(id,session))return this.confirmCart(session,id);
  if(!internal)check(!this.db.prepare('SELECT id FROM cart_quotes WHERE session=? AND instr(quotes,?)>0').get(session,id),'请确认整笔合并预览',409);
  if(!internal)this.db.exec('BEGIN IMMEDIATE');
  try{
   const q=this.db.prepare('SELECT * FROM quotes WHERE id=? AND session=?').get(id,session);check(q,'预览不存在',404);
   if(q.order_id){const result=this.order(session,q.order_id);if(!internal)this.db.exec('COMMIT');return {...result,replayed:true};}
   check(q.expires>=Date.now(),'预览已过期，请重新预览',409);
   const stock=this.db.prepare('UPDATE books SET stock=stock-? WHERE id=? AND stock>=? AND price=? RETURNING stock').get(q.quantity,q.book,q.quantity,q.price);
   check(stock,'库存或价格已变化，请重新预览',409);
   const orderId=randomUUID(),created=new Date().toISOString();
   this.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?)').run(orderId,session,q.book,q.quantity,q.quantity*q.price,created);
   this.db.prepare('UPDATE quotes SET order_id=? WHERE id=?').run(orderId,id);
   this.recordMovement({bookId:q.book,kind:'sale',delta:-q.quantity,stockAfter:stock.stock,created,orderId});
   const order=this.order(session,orderId);if(!internal)this.db.exec('COMMIT');return {...order,stock_before:stock.stock+q.quantity,stock_after:stock.stock};
  }catch(e){if(!internal)this.db.exec('ROLLBACK');throw e;}
 }
 order(session,id){
  const cart=this.db.prepare('SELECT * FROM cart_orders WHERE id=? AND session=?').get(id,session);
  if(cart){const items=JSON.parse(cart.children).map(child=>this.order(session,child));return {id:cart.id,created:cart.created,book_id:items.map(x=>x.book_id).join(', '),name:items.map(x=>x.name).join('、'),quantity:items.reduce((n,x)=>n+x.quantity,0),total_cents:items.reduce((n,x)=>n+x.total_cents,0),items};}
  check(typeof id==='string','缺少订单编号');const o=this.db.prepare('SELECT o.id,o.book AS book_id,b.name,o.quantity,o.total AS total_cents,o.created FROM orders o JOIN books b ON o.book=b.id WHERE o.id=? AND o.session=?').get(id,session);check(o,'订单不存在',404);return o;}
 quoteDetails(session,id){
  const q=this.db.prepare('SELECT q.*,b.name,b.stock FROM quotes q JOIN books b ON b.id=q.book WHERE q.id=? AND q.session=?').get(id,session);
  check(q,'预览不存在',404);
  return {quote_id:q.id,book_id:q.book,name:q.name,quantity:q.quantity,unit_price_cents:q.price,stock_at_preview:q.stock,total_cents:q.price*q.quantity,expires_at:new Date(q.expires).toISOString(),requires_user_confirmation:true};
 }
 cartDetails(session,cart){
  const items=JSON.parse(cart.quotes).map(id=>{const {quote_id,...item}=this.quoteDetails(session,id);return item;});
  return {quote_id:cart.id,items,name:items.map(x=>x.name).join('、'),quantity:items.reduce((n,x)=>n+x.quantity,0),total_cents:items.reduce((n,x)=>n+x.total_cents,0),expires_at:new Date(cart.expires).toISOString(),requires_user_confirmation:true};
 }
 quoteCart(session,items,internal=false){
  check(Array.isArray(items)&&items.length>=1&&items.length<=10,'请选择 1 至 10 种图书');
  check(items.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>['book_id','quantity'].includes(k))),'图书清单格式无效');
  check(new Set(items.map(x=>x.book_id)).size===items.length,'同一本书请合并数量后再预览');
  if(!internal)this.db.exec('BEGIN IMMEDIATE');
  try{
   const quotes=items.map(x=>this.quote(session,x));
   const id=randomUUID(),expires=Math.min(...quotes.map(x=>Date.parse(x.expires_at)));
   this.db.prepare('INSERT INTO cart_quotes VALUES(?,?,?,?,NULL)').run(id,session,JSON.stringify(quotes.map(x=>x.quote_id)),expires);
   const result=this.cartDetails(session,{id,quotes:JSON.stringify(quotes.map(x=>x.quote_id)),expires});
   if(!internal)this.db.exec('COMMIT');return result;
  }catch(e){if(!internal)this.db.exec('ROLLBACK');throw e;}
 }
 reviseCart(session,id,items){
  const old=this.db.prepare('SELECT * FROM cart_quotes WHERE id=? AND session=?').get(id,session);
  check(old,'预览不存在',404);check(!old.order_id,'订单已确认，请另建预览',409);check(old.expires>=Date.now(),'预览已过期，请重新预览',409);
  check(Array.isArray(items),'合并预览请提供完整图书清单及各项数量');
  this.db.exec('BEGIN IMMEDIATE');
  try{
  const result=this.quoteCart(session,items,true);
  this.db.prepare('DELETE FROM cart_quotes WHERE id=? AND session=?').run(id,session);
  for(const child of JSON.parse(old.quotes))this.db.prepare('DELETE FROM quotes WHERE id=? AND order_id IS NULL').run(child);
  this.db.exec('COMMIT');return {...result,replaces_quote_id:id};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 confirmCart(session,id){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const q=this.db.prepare('SELECT * FROM cart_quotes WHERE id=? AND session=?').get(id,session);check(q,'预览不存在',404);
   if(q.order_id){const result=this.order(session,q.order_id);this.db.exec('COMMIT');return {...result,replayed:true};}
   check(q.expires>=Date.now(),'预览已过期，请重新预览',409);
   const items=JSON.parse(q.quotes).map(child=>this.confirm(session,child,true));
   const orderId=randomUUID(),created=new Date().toISOString();
   this.db.prepare('INSERT INTO cart_orders VALUES(?,?,?,?)').run(orderId,session,JSON.stringify(items.map(x=>x.id)),created);
   this.db.prepare('UPDATE cart_quotes SET order_id=? WHERE id=?').run(orderId,id);
   const result=this.order(session,orderId);this.db.exec('COMMIT');
   return {...result,items:result.items.map((x,i)=>({...x,stock_before:items[i].stock_before,stock_after:items[i].stock_after}))};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 previews(session){
  const carts=this.db.prepare('SELECT * FROM cart_quotes WHERE session=? ORDER BY expires DESC').all(session);
  const childIds=new Set(carts.flatMap(x=>JSON.parse(x.quotes)));
  const singles=this.db.prepare('SELECT q.id,q.expires FROM quotes q WHERE q.session=? AND q.order_id IS NULL AND NOT EXISTS (SELECT 1 FROM cart_quotes c WHERE c.session=q.session AND instr(c.quotes,q.id)>0) ORDER BY q.expires DESC LIMIT 30').all(session).filter(x=>!childIds.has(x.id)).map(x=>this.quoteDetails(session,x.id));
  return [...singles,...carts.filter(x=>!x.order_id).map(x=>this.cartDetails(session,x))].sort((a,b)=>b.expires_at.localeCompare(a.expires_at)).slice(0,10);
 }
 context(session){return {previews:this.previews(session).filter(x=>Date.parse(x.expires_at)>=Date.now()).slice(0,3),recent_order:this.orders(session)[0]||null};}
 orders(session){
  const carts=this.db.prepare('SELECT id,children FROM cart_orders WHERE session=?').all(session);
  const children=new Set(carts.flatMap(x=>JSON.parse(x.children)));
  const singles=this.db.prepare('SELECT o.id,o.book AS book_id,b.name,o.quantity,o.total AS total_cents,o.created FROM orders o JOIN books b ON o.book=b.id WHERE session=? ORDER BY created DESC').all(session).filter(x=>!children.has(x.id));
  return [...singles,...carts.map(x=>this.order(session,x.id))].sort((a,b)=>b.created.localeCompare(a.created)).slice(0,100);
 }
 session(id){const x=this.db.prepare('SELECT history,expires FROM sessions WHERE id=?').get(id);if(!x||x.expires<Date.now())return null;try{return {history:JSON.parse(x.history),busy:false,last:Date.now()};}catch{return null;}}
 saveSession(id,session){this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET history=excluded.history,expires=excluded.expires').run(id,JSON.stringify(session.history),Date.now()+30*86400000);}
 close(){this.db.close();}
}
