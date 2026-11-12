import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(output, { recursive: true });
await cp(new URL('web/', root), output, { recursive: true });

const seed = JSON.parse(await readFile(new URL('data/books.json', root), 'utf8'));
const policies = new URL('policies/', root);
const names = (await readdir(policies)).filter(name => name.endsWith('.md')).sort();
const documents = Object.fromEntries(await Promise.all(names.map(async name => [
  name, await readFile(new URL(name, policies), 'utf8'),
])));
await writeFile(new URL('makers/data.generated.mjs', root),
  'export const seed = ' + JSON.stringify(seed) + ';\n' +
  'export const documents = ' + JSON.stringify(documents) + ';\n');

const frontScript = new URL('app.js', output);
const script = (await readFile(frontScript, 'utf8'))
  .replace("await fetch(path,data", "await requestBookshop(path,data")
  .replace("await fetch('/api/chat'", "await requestBookshop('/api/chat'")
  .replaceAll('本地演示', '在线演示')
  .replaceAll('Agnes 模型', '模型问答')
  .replace('请保持启动窗口运行后点击刷新。', '请稍后点击刷新重试。');
const browserAdapter = await readFile(new URL('makers/browser.js', root), 'utf8');
await writeFile(frontScript, browserAdapter + '\n' + script);

const frontPage = new URL('index.html', output);
const html = (await readFile(frontPage, 'utf8'))
  .replaceAll('本地演示', '在线演示')
  .replaceAll('Agnes 模型', '模型问答')
  .replace('查看库存、缺货提醒和本会话订单。', '查看库存、缺货提醒和订单。每位访客使用独立的模拟库存。')
  .replace('20261110-6', 'makers-1');
await writeFile(frontPage, html);
