import Database from 'better-sqlite3';

const db = new Database('energy.db');

function ensureColumn(name, ddl) {
  const cols = db.prepare('PRAGMA table_info(tasks)').all();
  if (!cols.find(c => c.name === name)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
    console.log(`Added column: ${name}`);
  } else {
    console.log(`Column exists: ${name}`);
  }
}

ensureColumn('schedule_mode', "schedule_mode TEXT NOT NULL DEFAULT 'flexible'");
ensureColumn('fixed_start', 'fixed_start TEXT');
ensureColumn('fixed_end', 'fixed_end TEXT');
ensureColumn('window_start_hour', 'window_start_hour INTEGER');
ensureColumn('window_end_hour', 'window_end_hour INTEGER');

console.log('Migration completed.');
