import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../sqlite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = await openDatabase(path.join(__dirname, '..', 'energy.db'));

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

function ensureSessionColumn(name, ddl) {
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  if (!cols.find(c => c.name === name)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
    console.log(`Added session column: ${name}`);
  } else {
    console.log(`Session column exists: ${name}`);
  }
}

ensureSessionColumn('paused_at', 'paused_at TEXT');
ensureSessionColumn('total_paused_minutes', 'total_paused_minutes INTEGER NOT NULL DEFAULT 0');

console.log('Migration completed.');
