import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { BookshopStore } from './bookshop-store.mjs';

export { BusinessError } from './bookshop-store.mjs';

export class Store extends BookshopStore {
  constructor(path = ':memory:') {
    const seed = JSON.parse(readFileSync(new URL('./data/books.json', import.meta.url)));
    super(new DatabaseSync(path), seed);
  }
}
