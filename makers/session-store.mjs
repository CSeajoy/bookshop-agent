import initSqlJs from 'sql.js/dist/sql-asm.js';
import { BookshopStore } from '../bookshop-store.mjs';
import { seed } from './data.generated.mjs';

let engine;
const databaseKey = 'bookshop.demo.sqlite.v1';

function queryRows(db, sql, parameters, all) {
  const statement = db.prepare(sql);
  try {
    statement.bind(parameters);
    if (!all) return statement.step() ? statement.getAsObject() : undefined;
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

export async function openStore(state) {
  engine ??= initSqlJs();
  const [SQL, saved] = await Promise.all([engine, state.get(databaseKey)]);
  const db = new SQL.Database(saved === null || saved === undefined ? undefined : Buffer.from(saved, 'base64'));
  try {
    const store = new BookshopStore({
      exec: sql => db.exec(sql),
      prepare: sql => ({
        get: (...parameters) => queryRows(db, sql, parameters, false),
        all: (...parameters) => queryRows(db, sql, parameters, true),
        run: (...parameters) => db.run(sql, parameters),
      }),
      close: () => db.close(),
    }, seed);
    const persist = async () => {
      const snapshot = Buffer.from(db.export()).toString('base64');
      db.exec('PRAGMA foreign_keys=ON');
      await state.set(databaseKey, snapshot);
    };
    return { store, persist };
  } catch (error) {
    db.close();
    throw error;
  }
}
