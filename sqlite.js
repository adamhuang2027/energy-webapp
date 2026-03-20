import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

function isLikelyWriteSql(sql = '') {
  const s = sql.trim().toUpperCase();
  return !(
    s.startsWith('SELECT') ||
    s.startsWith('PRAGMA') ||
    s.startsWith('WITH') ||
    s.startsWith('EXPLAIN')
  );
}

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  all(...params) {
    const stmt = this.db._db.prepare(this.sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(...params) {
    const stmt = this.db._db.prepare(this.sql);
    try {
      stmt.bind(params);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  run(...params) {
    const stmt = this.db._db.prepare(this.sql);
    try {
      stmt.run(params);
    } finally {
      stmt.free();
    }

    const changes = this.db._db.exec('SELECT changes() AS c')[0]?.values?.[0]?.[0] ?? 0;
    const lastInsertRowid = this.db._db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0] ?? 0;
    this.db._persist();
    return { changes, lastInsertRowid };
  }
}

export class SQLiteCompat {
  constructor(sqliteDb, filePath) {
    this._db = sqliteDb;
    this._filePath = filePath;
  }

  _persist() {
    const data = this._db.export();
    fs.writeFileSync(this._filePath, Buffer.from(data));
  }

  pragma(sql) {
    this._db.exec(`PRAGMA ${sql}`);
  }

  exec(sql) {
    this._db.exec(sql);
    if (isLikelyWriteSql(sql)) this._persist();
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN');
      try {
        const out = fn(...args);
        this.exec('COMMIT');
        return out;
      } catch (err) {
        this.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

export async function openDatabase(filePath) {
  const SQL = await initSqlJs();
  const abs = path.resolve(filePath);
  const fileExists = fs.existsSync(abs);
  const sqliteDb = fileExists
    ? new SQL.Database(new Uint8Array(fs.readFileSync(abs)))
    : new SQL.Database();

  const db = new SQLiteCompat(sqliteDb, abs);
  if (!fileExists) db._persist();
  return db;
}
