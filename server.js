import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;
const db = new Database(path.join(__dirname, 'energy.db'));

db.pragma('journal_mode = WAL');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      estimated_minutes INTEGER,
      energy_demand INTEGER NOT NULL CHECK (energy_demand BETWEEN 1 AND 5),
      focus_type TEXT NOT NULL CHECK (focus_type IN ('deep','shallow','social')),
      context_location TEXT,
      context_device TEXT,
      need_block INTEGER NOT NULL DEFAULT 0,
      importance TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('mit','normal')),
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
      scheduled_start TEXT,
      scheduled_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS energy_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_date TEXT NOT NULL,
      slot TEXT NOT NULL CHECK (slot IN ('morning','noon','evening')),
      energy INTEGER NOT NULL CHECK (energy BETWEEN 1 AND 5),
      focus INTEGER NOT NULL CHECK (focus BETWEEN 1 AND 5),
      mood INTEGER NOT NULL CHECK (mood BETWEEN 1 AND 5),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(checkin_date, slot)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      duration_minutes INTEGER,
      actual_energy_cost INTEGER,
      reason_tags TEXT DEFAULT '[]',
      interruptions_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS daily_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_date TEXT NOT NULL UNIQUE,
      weighted_completion_rate REAL NOT NULL,
      mismatch_count INTEGER NOT NULL,
      debt_score REAL NOT NULL,
      suggestion_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

initDb();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getCheckinsMap(date) {
  const rows = db.prepare('SELECT * FROM energy_checkins WHERE checkin_date = ?').all(date);
  const map = { morning: null, noon: null, evening: null };
  for (const r of rows) map[r.slot] = r;
  return map;
}

function slotEnergyLevel(value) {
  if (value >= 4) return 'high';
  if (value <= 2) return 'low';
  return 'mid';
}

function generateSchedule(date, strategy = 'steady') {
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('todo','doing') ORDER BY importance DESC, energy_demand DESC, created_at ASC")
    .all();

  const checkins = getCheckinsMap(date);
  const baseCurve = {
    morning: checkins.morning?.energy ?? 4,
    noon: checkins.noon?.energy ?? 3,
    evening: checkins.evening?.energy ?? 2,
  };

  if (strategy === 'sprint') {
    baseCurve.morning = Math.min(5, baseCurve.morning + 1);
  } else if (strategy === 'conservative') {
    baseCurve.evening = Math.max(1, baseCurve.evening - 1);
  }

  const windows = [
    { slot: 'morning', start: `${date}T09:00:00`, end: `${date}T12:00:00`, energy: baseCurve.morning },
    { slot: 'noon', start: `${date}T13:30:00`, end: `${date}T17:30:00`, energy: baseCurve.noon },
    { slot: 'evening', start: `${date}T20:00:00`, end: `${date}T22:00:00`, energy: baseCurve.evening },
  ];

  const sortedWindows = [...windows].sort((a, b) => b.energy - a.energy);
  const recommendations = [];

  for (const task of tasks) {
    let targetWindow = sortedWindows[0];
    if (task.energy_demand >= 4) {
      targetWindow = sortedWindows[0];
    } else if (task.energy_demand <= 2) {
      targetWindow = windows.find(w => w.slot === 'evening') || sortedWindows[2];
    } else {
      targetWindow = sortedWindows[1] || sortedWindows[0];
    }

    const duration = task.estimated_minutes || (task.energy_demand >= 4 ? 90 : 45);
    const start = targetWindow.start;
    const endDate = new Date(new Date(start).getTime() + duration * 60 * 1000);

    const energyFit = 1 - Math.abs(task.energy_demand - targetWindow.energy) / 4;
    const priority = task.importance === 'mit' ? 1 : 0.5;
    const matchScore = Number((energyFit * 0.7 + priority * 0.3).toFixed(2));

    recommendations.push({
      taskId: task.id,
      title: task.title,
      slot: targetWindow.slot,
      start,
      end: endDate.toISOString(),
      matchScore,
      reason: `任务能耗(${task.energy_demand})匹配${targetWindow.slot}能量(${targetWindow.energy})`,
    });
  }

  return {
    windows: windows.map(w => ({ slot: w.slot, energyLevel: slotEnergyLevel(w.energy), energy: w.energy })),
    recommendations,
  };
}

function computeDailyReview(date) {
  const tasks = db.prepare("SELECT * FROM tasks").all();
  const sessions = db.prepare('SELECT * FROM sessions WHERE date(start_at) = ?').all(date);
  const checkins = getCheckinsMap(date);

  let totalWeight = 0;
  let doneWeight = 0;
  for (const t of tasks) {
    const w = t.importance === 'mit' ? 3 : 1;
    totalWeight += w;
    if (t.status === 'done') doneWeight += w;
  }

  const weightedCompletionRate = totalWeight > 0 ? doneWeight / totalWeight : 0;

  let mismatchCount = 0;
  for (const s of sessions) {
    const hour = new Date(s.start_at).getUTCHours();
    let slot = 'evening';
    if (hour >= 9 && hour < 12) slot = 'morning';
    else if (hour >= 13 && hour < 18) slot = 'noon';

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(s.task_id);
    const slotEnergy = checkins[slot]?.energy ?? (slot === 'morning' ? 4 : slot === 'noon' ? 3 : 2);
    if (task && task.energy_demand >= 4 && slotEnergy <= 2) mismatchCount += 1;
  }

  const debtScore = Number((mismatchCount * 0.8 + (1 - weightedCompletionRate) * 2).toFixed(2));
  let suggestion = '保持今天节奏，明天先做一个高能耗 MIT。';
  if (mismatchCount >= 2) {
    suggestion = '你今天高能任务错配较多，建议明天把 MIT 前移到上午高能窗口。';
  } else if (weightedCompletionRate < 0.5) {
    suggestion = '明天减少任务数量，保留 1 个 MIT + 2 个次要任务。';
  }

  return { weightedCompletionRate, mismatchCount, debtScore, suggestion };
}

// --- Task APIs ---
app.get('/api/v1/tasks', (req, res) => {
  const status = req.query.status;
  let query = 'SELECT * FROM tasks ORDER BY created_at DESC';
  let rows;
  if (status) {
    const statuses = String(status).split(',').map(s => s.trim());
    const placeholders = statuses.map(() => '?').join(',');
    query = `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at DESC`;
    rows = db.prepare(query).all(...statuses);
  } else {
    rows = db.prepare(query).all();
  }
  res.json({ data: rows, error: null });
});

app.post('/api/v1/tasks', (req, res) => {
  const { title, estimatedMinutes, energyDemand, focusType = 'deep', context = {}, importance = 'normal' } = req.body;
  if (!title || !energyDemand) return res.status(400).json({ error: 'title and energyDemand are required' });

  if (importance === 'mit') {
    const existingMit = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE importance='mit' AND status IN ('todo','doing')").get().c;
    if (existingMit >= 1) return res.status(422).json({ error: 'Only one MIT is allowed in v0.1' });
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (title, estimated_minutes, energy_demand, focus_type, context_location, context_device, need_block, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    title,
    estimatedMinutes ?? null,
    energyDemand,
    focusType,
    context.location ?? null,
    context.device ?? null,
    context.needBlock ? 1 : 0,
    importance
  );
  const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ data: created, error: null });
});

app.patch('/api/v1/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const merged = {
    ...existing,
    title: req.body.title ?? existing.title,
    estimated_minutes: req.body.estimatedMinutes ?? existing.estimated_minutes,
    energy_demand: req.body.energyDemand ?? existing.energy_demand,
    focus_type: req.body.focusType ?? existing.focus_type,
    importance: req.body.importance ?? existing.importance,
    status: req.body.status ?? existing.status,
    scheduled_start: req.body.scheduledStart ?? existing.scheduled_start,
    scheduled_end: req.body.scheduledEnd ?? existing.scheduled_end,
    updated_at: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE tasks
    SET title=?, estimated_minutes=?, energy_demand=?, focus_type=?, importance=?, status=?, scheduled_start=?, scheduled_end=?, updated_at=?
    WHERE id=?
  `).run(
    merged.title,
    merged.estimated_minutes,
    merged.energy_demand,
    merged.focus_type,
    merged.importance,
    merged.status,
    merged.scheduled_start,
    merged.scheduled_end,
    merged.updated_at,
    id
  );

  res.json({ data: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), error: null });
});

// --- Checkins ---
app.get('/api/v1/energy-checkins', (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare('SELECT * FROM energy_checkins WHERE checkin_date = ? ORDER BY slot').all(date);
  res.json({ data: rows, error: null });
});

app.post('/api/v1/energy-checkins', (req, res) => {
  const { date = todayStr(), slot, energy, focus, mood } = req.body;
  if (!slot || !energy || !focus || !mood) return res.status(400).json({ error: 'slot, energy, focus, mood are required' });

  db.prepare(`
    INSERT INTO energy_checkins (checkin_date, slot, energy, focus, mood, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(checkin_date, slot) DO UPDATE SET
      energy=excluded.energy,
      focus=excluded.focus,
      mood=excluded.mood,
      updated_at=datetime('now')
  `).run(date, slot, energy, focus, mood);

  res.json({ data: db.prepare('SELECT * FROM energy_checkins WHERE checkin_date=? AND slot=?').get(date, slot), error: null });
});

// --- Sessions ---
app.post('/api/v1/sessions/start', (req, res) => {
  const { taskId, startedAt = new Date().toISOString() } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });

  const running = db.prepare('SELECT * FROM sessions WHERE task_id = ? AND end_at IS NULL').get(taskId);
  if (running) return res.status(409).json({ error: 'Task already has a running session' });

  const info = db.prepare('INSERT INTO sessions (task_id, start_at) VALUES (?, ?)').run(taskId, startedAt);
  db.prepare("UPDATE tasks SET status='doing', updated_at=? WHERE id=?").run(new Date().toISOString(), taskId);

  res.json({ data: db.prepare('SELECT * FROM sessions WHERE id=?').get(info.lastInsertRowid), error: null });
});

app.post('/api/v1/sessions/:id/end', (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.end_at) return res.status(409).json({ error: 'Session already ended' });

  const { endedAt = new Date().toISOString(), actualEnergyCost, reasonTags = [], interruptionsCount = 0, markDone = true } = req.body;
  const durationMinutes = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(session.start_at).getTime()) / 60000));

  db.prepare(`
    UPDATE sessions
    SET end_at=?, duration_minutes=?, actual_energy_cost=?, reason_tags=?, interruptions_count=?, updated_at=?
    WHERE id=?
  `).run(endedAt, durationMinutes, actualEnergyCost ?? null, JSON.stringify(reasonTags), interruptionsCount, new Date().toISOString(), id);

  const newStatus = markDone ? 'done' : 'todo';
  db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(newStatus, new Date().toISOString(), session.task_id);

  res.json({ data: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id), error: null });
});

app.get('/api/v1/sessions', (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare('SELECT * FROM sessions WHERE date(start_at)=? ORDER BY start_at DESC').all(date);
  res.json({ data: rows, error: null });
});

// --- Schedule ---
app.post('/api/v1/schedule/generate', (req, res) => {
  const { date = todayStr(), strategy = 'steady' } = req.body;
  const result = generateSchedule(date, strategy);
  res.json({ data: result, error: null });
});

app.post('/api/v1/schedule/apply', (req, res) => {
  const { recommendations = [] } = req.body;
  const updateStmt = db.prepare('UPDATE tasks SET scheduled_start=?, scheduled_end=?, updated_at=? WHERE id=?');
  const now = new Date().toISOString();

  const tx = db.transaction((recs) => {
    for (const r of recs) updateStmt.run(r.start, r.end, now, r.taskId);
  });

  tx(recommendations);
  res.json({ data: { updated: recommendations.length }, error: null });
});

// --- Review ---
app.get('/api/v1/review/daily', (req, res) => {
  const date = req.query.date || todayStr();
  const review = computeDailyReview(date);

  db.prepare(`
    INSERT INTO daily_reviews (review_date, weighted_completion_rate, mismatch_count, debt_score, suggestion_text)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(review_date) DO UPDATE SET
      weighted_completion_rate=excluded.weighted_completion_rate,
      mismatch_count=excluded.mismatch_count,
      debt_score=excluded.debt_score,
      suggestion_text=excluded.suggestion_text
  `).run(date, review.weightedCompletionRate, review.mismatchCount, review.debtScore, review.suggestion);

  const row = db.prepare('SELECT * FROM daily_reviews WHERE review_date=?').get(date);
  res.json({ data: row, error: null });
});

app.get('/api/v1/health', (_req, res) => res.json({ data: { ok: true }, error: null }));

app.listen(PORT, () => {
  console.log(`Energy app running on http://localhost:${PORT}`);
});
