import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { indexDocument, matchRules } from './rule-search.mjs';

const folder = new URL('./policies/', import.meta.url);
const cache = new URL('./runtime/rule-index.json', import.meta.url);
let index;

export function buildIndex() {
  mkdirSync(new URL('./runtime/', import.meta.url), { recursive: true });
  let previous = {};
  try {
    if (existsSync(cache)) previous = JSON.parse(readFileSync(cache, 'utf8'));
  } catch {}
  const files = {};
  let changed = 0;
  for (const name of readdirSync(folder).filter(file => file.endsWith('.md'))) {
    const text = readFileSync(new URL(name, folder), 'utf8');
    const hash = createHash('sha256').update(text).digest('hex');
    if (previous[name]?.hash === hash) {
      files[name] = previous[name];
    } else {
      files[name] = { hash, chunks: indexDocument(name, text) };
      changed++;
    }
  }
  writeFileSync(cache, JSON.stringify(files));
  return { files, changed };
}

export function searchRules(query) {
  index ??= buildIndex();
  return matchRules(query, Object.values(index.files).flatMap(file => file.chunks));
}
