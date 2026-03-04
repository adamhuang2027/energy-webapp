import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import session from 'express-session';
import { google } from 'googleapis';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'energy-dev-secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${APP_BASE_URL}/api/v1/oauth/google/callback`;
const GCAL_API_KEY = process.env.GCAL_API_KEY || '';
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID || 'primary';
const GCAL_TIMEZONE = process.env.GCAL_TIMEZONE || 'America/Chicago';
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
      schedule_mode TEXT NOT NULL DEFAULT 'flexible' CHECK (schedule_mode IN ('fixed','flexible','windowed')),
      fixed_start TEXT,
      fixed_end TEXT,
      window_start_hour INTEGER,
      window_end_hour INTEGER,
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
      paused_at TEXT,
      total_paused_minutes INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      scope TEXT,
      token_type TEXT,
      expiry_date INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const ensureColumn = (name, ddl) => {
    const cols = db.prepare("PRAGMA table_info(tasks)").all();
    if (!cols.find(c => c.name === name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
  };
  ensureColumn('schedule_mode', "schedule_mode TEXT NOT NULL DEFAULT 'flexible'");
  ensureColumn('fixed_start', 'fixed_start TEXT');
  ensureColumn('fixed_end', 'fixed_end TEXT');
  ensureColumn('window_start_hour', 'window_start_hour INTEGER');
  ensureColumn('window_end_hour', 'window_end_hour INTEGER');

  const ensureSessionColumn = (name, ddl) => {
    const cols = db.prepare("PRAGMA table_info(sessions)").all();
    if (!cols.find(c => c.name === name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  };
  ensureSessionColumn('paused_at', 'paused_at TEXT');
  ensureSessionColumn('total_paused_minutes', 'total_paused_minutes INTEGER NOT NULL DEFAULT 0');
}

initDb();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function getDateStrInTimezone(date = new Date(), timeZone = GCAL_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function todayStr() {
  return getDateStrInTimezone(new Date(), GCAL_TIMEZONE);
}

function getDayUtcRange(date, timeZone = GCAL_TIMEZONE) {
  const start = zonedTimeToUtcIso(date, 0, 0, timeZone);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const nextDate = d.toISOString().slice(0, 10);
  const end = zonedTimeToUtcIso(nextDate, 0, 0, timeZone);
  return { start, end };
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

function toSlotByHourLocal(hour) {
  if (hour >= 7 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'noon';
  return 'evening';
}

function toSlotByDateTime(isoOrDate, timeZone = GCAL_TIMEZONE) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const { hour } = getHourMinuteInTimezone(d, timeZone);
  return toSlotByHourLocal(hour);
}

function zonedTimeToUtcIso(date, hour, minute, timeZone = GCAL_TIMEZONE) {
  const [y, m, d] = date.split('-').map(Number);
  const targetUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  let utcMs = targetUtc;

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second));
    const diff = asUtc - targetUtc;
    utcMs -= diff;
  }

  return new Date(utcMs).toISOString();
}

function getHourMinuteInTimezone(date, timeZone = GCAL_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { hour: Number(map.hour), minute: Number(map.minute) };
}

function getSlotMeetingLoad(events = []) {
  const slotLoad = { morning: 0, noon: 0, evening: 0 };
  for (const e of events) {
    const start = new Date(e.start.dateTime || e.start.date);
    const end = new Date(e.end.dateTime || e.end.date);
    const durationMin = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
    const slot = toSlotByDateTime(start, GCAL_TIMEZONE);
    slotLoad[slot] += durationMin;
  }
  return slotLoad;
}

function getOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

function loadSavedGoogleTokens() {
  return db.prepare("SELECT * FROM oauth_tokens WHERE provider='google'").get();
}

function saveGoogleTokens(tokens = {}) {
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, scope, token_type, expiry_date, updated_at)
    VALUES ('google', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
      scope=excluded.scope,
      token_type=excluded.token_type,
      expiry_date=excluded.expiry_date,
      updated_at=datetime('now')
  `).run(tokens.access_token || null, tokens.refresh_token || null, tokens.scope || null, tokens.token_type || null, tokens.expiry_date || null);
}

async function fetchGoogleCalendarEvents(date) {
  const { start: timeMin, end: timeMax } = getDayUtcRange(date, GCAL_TIMEZONE);

  // Priority 1: OAuth (private calendars)
  const oauthClient = getOAuthClient();
  const saved = loadSavedGoogleTokens();
  if (oauthClient && saved?.access_token) {
    oauthClient.setCredentials({
      access_token: saved.access_token,
      refresh_token: saved.refresh_token,
      scope: saved.scope,
      token_type: saved.token_type,
      expiry_date: saved.expiry_date,
    });
    try {
      const calendar = google.calendar({ version: 'v3', auth: oauthClient });
      const result = await calendar.events.list({
        calendarId: GCAL_CALENDAR_ID || 'primary',
        singleEvents: true,
        orderBy: 'startTime',
        timeMin,
        timeMax,
        timeZone: GCAL_TIMEZONE,
      });
      const fresh = oauthClient.credentials;
      if (fresh?.access_token) saveGoogleTokens(fresh);
      return { enabled: true, authMode: 'oauth', reason: null, events: result.data.items || [] };
    } catch (e) {
      // fall through to api key if available
    }
  }

  // Priority 2: API key mode
  if (GCAL_API_KEY) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GCAL_CALENDAR_ID || 'primary')}/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&key=${encodeURIComponent(GCAL_API_KEY)}&timeZone=${encodeURIComponent(GCAL_TIMEZONE)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      return { enabled: true, authMode: 'apiKey', reason: `Google Calendar fetch failed: ${resp.status}`, events: [] };
    }
    const json = await resp.json();
    return { enabled: true, authMode: 'apiKey', reason: null, events: json.items || [] };
  }

  return { enabled: false, authMode: 'none', reason: 'No Google auth configured. Use OAuth (recommended) or API key.', events: [] };
}

function generateSchedule(date, strategy = 'steady', meetingLoad = { morning: 0, noon: 0, evening: 0 }) {
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('todo','doing') ORDER BY importance DESC, energy_demand DESC, created_at ASC")
    .all();
  const fixedTasks = tasks.filter(t => t.schedule_mode === 'fixed' && t.fixed_start && t.fixed_end);
  const flexibleTasks = tasks.filter(t => t.schedule_mode !== 'fixed');

  const checkins = getCheckinsMap(date);
  const baseCurve = {
    morning: checkins.morning?.energy ?? 4,
    noon: checkins.noon?.energy ?? 3,
    evening: checkins.evening?.energy ?? 2,
  };

  if (strategy === 'sprint') baseCurve.morning = Math.min(5, baseCurve.morning + 1);
  if (strategy === 'conservative') baseCurve.evening = Math.max(1, baseCurve.evening - 1);

  const windows = [
    { slot: 'morning', start: zonedTimeToUtcIso(date, 9, 0), end: zonedTimeToUtcIso(date, 12, 0), energy: baseCurve.morning, cursorMin: 0, lengthMin: 180 },
    { slot: 'noon', start: zonedTimeToUtcIso(date, 13, 30), end: zonedTimeToUtcIso(date, 18, 0), energy: baseCurve.noon, cursorMin: 0, lengthMin: 270 },
    { slot: 'evening', start: zonedTimeToUtcIso(date, 19, 0), end: zonedTimeToUtcIso(date, 23, 0), energy: baseCurve.evening, cursorMin: 0, lengthMin: 240 },
  ].map(w => ({ ...w, availableMin: Math.max(30, w.lengthMin - Math.min(w.lengthMin - 30, meetingLoad[w.slot] || 0)) }));

  const recommendations = [];

  for (const task of fixedTasks) {
    const fixedStart = new Date(task.fixed_start);
    const fixedEnd = new Date(task.fixed_end);
    const sHM = getHourMinuteInTimezone(fixedStart, GCAL_TIMEZONE);
    const eHM = getHourMinuteInTimezone(fixedEnd, GCAL_TIMEZONE);

    let startIso = zonedTimeToUtcIso(date, sHM.hour, sHM.minute);
    let endIso = zonedTimeToUtcIso(date, eHM.hour, eHM.minute);

    let s = new Date(startIso);
    let e = new Date(endIso);
    if (e <= s) {
      const fallbackMin = task.estimated_minutes || 60;
      e = new Date(s.getTime() + fallbackMin * 60000);
      endIso = e.toISOString();
    }

    const duration = Math.max(1, Math.round((e.getTime() - s.getTime()) / 60000));
    const slot = toSlotByDateTime(s, GCAL_TIMEZONE);
    const target = windows.find(w => w.slot === slot);
    if (target) target.availableMin = Math.max(0, target.availableMin - duration);

    recommendations.push({
      taskId: task.id,
      title: task.title,
      slot,
      start: startIso,
      end: endIso,
      duration,
      matchScore: 1,
      reason: 'fixed task (locked time)',
      scheduleMode: 'fixed',
    });
  }

  let lastFocusType = null;
  let lastDevice = null;

  for (const task of flexibleTasks) {
    const idealDuration = task.estimated_minutes || (task.energy_demand >= 4 ? 90 : task.energy_demand <= 2 ? 30 : 50);
    const maxBlock = strategy === 'sprint' ? 120 : strategy === 'conservative' ? 60 : 90;
    const minBlock = task.energy_demand >= 4 ? 45 : 25;
    const duration = Math.max(minBlock, Math.min(maxBlock, idealDuration));

    let best = null;
    for (const w of windows) {
      const remains = w.availableMin - w.cursorMin;
      if (remains < duration) continue;

      const candidateStart = new Date(new Date(w.start).getTime() + w.cursorMin * 60000);
      const candidateEnd = new Date(candidateStart.getTime() + duration * 60000);

      if (task.schedule_mode === 'windowed') {
        let windowStartVal = task.window_start_hour;
        let windowEndVal = task.window_end_hour;

        // Support minute-precision window via fixed_start/fixed_end inputs.
        if ((windowStartVal == null || windowEndVal == null) && task.fixed_start && task.fixed_end) {
          const ws = getHourMinuteInTimezone(new Date(task.fixed_start), GCAL_TIMEZONE);
          const we = getHourMinuteInTimezone(new Date(task.fixed_end), GCAL_TIMEZONE);
          windowStartVal = ws.hour + ws.minute / 60;
          windowEndVal = we.hour + we.minute / 60;
        }

        if (windowStartVal != null && windowEndVal != null) {
          const s = getHourMinuteInTimezone(candidateStart, GCAL_TIMEZONE);
          const e = getHourMinuteInTimezone(candidateEnd, GCAL_TIMEZONE);
          const startVal = s.hour + s.minute / 60;
          const endVal = e.hour + e.minute / 60;
          if (startVal < windowStartVal || endVal > windowEndVal) continue;
        }
      }

      const energyFit = 1 - Math.abs(task.energy_demand - w.energy) / 4;
      const priority = task.importance === 'mit' ? 1 : 0.5;
      const switchPenalty = (lastFocusType && lastFocusType !== task.focus_type ? 0.12 : 0) +
        (lastDevice && task.context_device && lastDevice !== task.context_device ? 0.08 : 0);
      const meetingPenalty = Math.min(0.25, (meetingLoad[w.slot] || 0) / 240 * 0.25);

      const score = energyFit * 0.55 + priority * 0.25 + (1 - switchPenalty) * 0.12 + (1 - meetingPenalty) * 0.08;
      if (!best || score > best.score) best = { w, score, switchPenalty, meetingPenalty };
    }

    if (!best) continue;

    const startDate = new Date(new Date(best.w.start).getTime() + best.w.cursorMin * 60000);
    const endDate = new Date(startDate.getTime() + duration * 60000);
    best.w.cursorMin += duration;

    const reasonBits = [
      `energy fit ${Math.round((1 - Math.abs(task.energy_demand - best.w.energy) / 4) * 100)}%`,
      best.switchPenalty > 0 ? 'switch cost applied' : 'low switch cost',
      (meetingLoad[best.w.slot] || 0) > 0 ? `meeting load ${meetingLoad[best.w.slot]}m` : 'light meeting load',
      `mode ${task.schedule_mode}`,
    ];

    recommendations.push({
      taskId: task.id,
      title: task.title,
      slot: best.w.slot,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      duration,
      matchScore: Number(best.score.toFixed(2)),
      reason: reasonBits.join(' · '),
      scheduleMode: task.schedule_mode,
    });

    lastFocusType = task.focus_type;
    lastDevice = task.context_device || lastDevice;

    if (best.w.cursorMin >= 90) best.w.cursorMin += 10;
  }

  return {
    windows: windows.map(w => ({
      slot: w.slot,
      energyLevel: slotEnergyLevel(w.energy),
      energy: w.energy,
      meetingMinutes: meetingLoad[w.slot] || 0,
      availableMinutes: w.availableMin,
    })),
    recommendations,
  };
}

function computeDailyReview(date) {
  const tasks = db.prepare("SELECT * FROM tasks").all();
  const { start, end } = getDayUtcRange(date, GCAL_TIMEZONE);
  const sessions = db.prepare('SELECT * FROM sessions WHERE start_at >= ? AND start_at < ?').all(start, end);
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
    const slot = toSlotByDateTime(s.start_at, GCAL_TIMEZONE);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(s.task_id);
    const slotEnergy = checkins[slot]?.energy ?? (slot === 'morning' ? 4 : slot === 'noon' ? 3 : 2);
    if (task && task.energy_demand >= 4 && slotEnergy <= 2) mismatchCount += 1;
  }

  const debtScore = Number((mismatchCount * 0.8 + (1 - weightedCompletionRate) * 2).toFixed(2));
  let suggestion = 'Keep today’s rhythm. Start tomorrow with one high-energy MIT.';
  if (mismatchCount >= 2) {
    suggestion = 'You had several high-energy mismatches today. Move your MIT to the morning high-energy window.';
  } else if (weightedCompletionRate < 0.5) {
    suggestion = 'Reduce task load tomorrow: keep 1 MIT + 2 secondary tasks.';
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
  const {
    title,
    estimatedMinutes,
    energyDemand,
    focusType = 'deep',
    context = {},
    importance = 'normal',
    scheduleMode = 'flexible',
    fixedStart = null,
    fixedEnd = null,
    windowStartHour = null,
    windowEndHour = null,
  } = req.body;
  if (!title || !energyDemand) return res.status(400).json({ error: 'title and energyDemand are required' });

  if (importance === 'mit') {
    const existingMit = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE importance='mit' AND status IN ('todo','doing')").get().c;
    if (existingMit >= 1) return res.status(422).json({ error: 'Only one MIT is allowed in v0.1' });
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (title, estimated_minutes, energy_demand, focus_type, context_location, context_device, need_block, importance, schedule_mode, fixed_start, fixed_end, window_start_hour, window_end_hour)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    title,
    estimatedMinutes ?? null,
    energyDemand,
    focusType,
    context.location ?? null,
    context.device ?? null,
    context.needBlock ? 1 : 0,
    importance,
    scheduleMode,
    fixedStart,
    fixedEnd,
    windowStartHour,
    windowEndHour
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
    schedule_mode: req.body.scheduleMode ?? existing.schedule_mode,
    fixed_start: req.body.fixedStart ?? existing.fixed_start,
    fixed_end: req.body.fixedEnd ?? existing.fixed_end,
    window_start_hour: req.body.windowStartHour ?? existing.window_start_hour,
    window_end_hour: req.body.windowEndHour ?? existing.window_end_hour,
    scheduled_start: req.body.scheduledStart ?? existing.scheduled_start,
    scheduled_end: req.body.scheduledEnd ?? existing.scheduled_end,
    updated_at: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE tasks
    SET title=?, estimated_minutes=?, energy_demand=?, focus_type=?, importance=?, status=?, schedule_mode=?, fixed_start=?, fixed_end=?, window_start_hour=?, window_end_hour=?, scheduled_start=?, scheduled_end=?, updated_at=?
    WHERE id=?
  `).run(
    merged.title,
    merged.estimated_minutes,
    merged.energy_demand,
    merged.focus_type,
    merged.importance,
    merged.status,
    merged.schedule_mode,
    merged.fixed_start,
    merged.fixed_end,
    merged.window_start_hour,
    merged.window_end_hour,
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

app.post('/api/v1/sessions/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.end_at) return res.status(409).json({ error: 'Session already ended' });
  if (session.paused_at) return res.status(409).json({ error: 'Session already paused' });

  const pausedAt = req.body.pausedAt || new Date().toISOString();
  db.prepare('UPDATE sessions SET paused_at=?, updated_at=? WHERE id=?').run(pausedAt, new Date().toISOString(), id);
  res.json({ data: db.prepare('SELECT * FROM sessions WHERE id=?').get(id), error: null });
});

app.post('/api/v1/sessions/:id/resume', (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.end_at) return res.status(409).json({ error: 'Session already ended' });
  if (!session.paused_at) return res.status(409).json({ error: 'Session is not paused' });

  const resumedAt = req.body.resumedAt || new Date().toISOString();
  const pausedMin = Math.max(0, Math.round((new Date(resumedAt).getTime() - new Date(session.paused_at).getTime()) / 60000));
  const totalPaused = (session.total_paused_minutes || 0) + pausedMin;
  db.prepare('UPDATE sessions SET paused_at=NULL, total_paused_minutes=?, updated_at=? WHERE id=?')
    .run(totalPaused, new Date().toISOString(), id);
  res.json({ data: db.prepare('SELECT * FROM sessions WHERE id=?').get(id), error: null });
});

app.post('/api/v1/sessions/:id/end', (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.end_at) return res.status(409).json({ error: 'Session already ended' });

  const { endedAt = new Date().toISOString(), actualEnergyCost, reasonTags = [], interruptionsCount = 0, markDone = true } = req.body;

  let totalPausedMinutes = session.total_paused_minutes || 0;
  if (session.paused_at) {
    totalPausedMinutes += Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(session.paused_at).getTime()) / 60000));
  }

  const rawDuration = Math.round((new Date(endedAt).getTime() - new Date(session.start_at).getTime()) / 60000);
  const durationMinutes = Math.max(1, rawDuration - totalPausedMinutes);

  db.prepare(`
    UPDATE sessions
    SET end_at=?, paused_at=NULL, total_paused_minutes=?, duration_minutes=?, actual_energy_cost=?, reason_tags=?, interruptions_count=?, updated_at=?
    WHERE id=?
  `).run(endedAt, totalPausedMinutes, durationMinutes, actualEnergyCost ?? null, JSON.stringify(reasonTags), interruptionsCount, new Date().toISOString(), id);

  const newStatus = markDone ? 'done' : 'todo';
  db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(newStatus, new Date().toISOString(), session.task_id);

  res.json({ data: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id), error: null });
});

app.get('/api/v1/sessions', (req, res) => {
  const date = req.query.date || todayStr();
  const { start, end } = getDayUtcRange(date, GCAL_TIMEZONE);
  const rows = db.prepare('SELECT * FROM sessions WHERE start_at >= ? AND start_at < ? ORDER BY start_at DESC').all(start, end);
  res.json({ data: rows, error: null });
});

app.get('/api/v1/sessions/running', (_req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE end_at IS NULL ORDER BY start_at DESC LIMIT 1').get();
  res.json({ data: row || null, error: null });
});

// --- Schedule ---
app.post('/api/v1/schedule/generate', async (req, res) => {
  const { date = todayStr(), strategy = 'steady', includeCalendar = true } = req.body;
  let calendar = { enabled: false, reason: 'Calendar integration disabled', events: [] };
  if (includeCalendar) {
    calendar = await fetchGoogleCalendarEvents(date);
  }
  const meetingLoad = getSlotMeetingLoad(calendar.events || []);
  const result = generateSchedule(date, strategy, meetingLoad);
  res.json({ data: { ...result, calendar: { enabled: calendar.enabled, reason: calendar.reason, meetingLoad, meetingCount: (calendar.events || []).length } }, error: null });
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

// --- OAuth (Google Calendar) ---
app.get('/api/v1/oauth/google/start', (req, res) => {
  const oauthClient = getOAuthClient();
  if (!oauthClient) return res.status(400).json({ data: null, error: 'Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET' });
  const state = Math.random().toString(36).slice(2);
  req.session.oauthState = state;
  const authUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
    prompt: 'consent',
    state,
  });
  res.redirect(authUrl);
});

app.get('/api/v1/oauth/google/callback', async (req, res) => {
  const oauthClient = getOAuthClient();
  if (!oauthClient) return res.status(400).send('OAuth not configured');
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  if (!state || state !== req.session.oauthState) return res.status(400).send('Invalid state');

  try {
    const { tokens } = await oauthClient.getToken(String(code));
    saveGoogleTokens(tokens);
    res.redirect('/?oauth=google_connected');
  } catch (e) {
    res.status(500).send('Google OAuth failed');
  }
});

app.get('/api/v1/oauth/google/status', (_req, res) => {
  const oauthReady = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  const saved = loadSavedGoogleTokens();
  res.json({
    data: {
      oauthConfigured: oauthReady,
      connected: Boolean(saved?.access_token),
      redirectUri: GOOGLE_REDIRECT_URI,
      calendarId: GCAL_CALENDAR_ID,
      timezone: GCAL_TIMEZONE,
    },
    error: null,
  });
});

app.post('/api/v1/oauth/google/logout', (_req, res) => {
  db.prepare("DELETE FROM oauth_tokens WHERE provider='google'").run();
  res.json({ data: { disconnected: true }, error: null });
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

app.get('/api/v1/calendar/meeting-density', async (req, res) => {
  const date = req.query.date || todayStr();
  const calendar = await fetchGoogleCalendarEvents(date);
  const slotLoad = getSlotMeetingLoad(calendar.events || []);
  const totalMinutes = Object.values(slotLoad).reduce((a, b) => a + b, 0);
  const densityLevel = totalMinutes >= 240 ? 'high' : totalMinutes >= 120 ? 'mid' : 'low';
  res.json({
    data: {
      date,
      enabled: calendar.enabled,
      reason: calendar.reason,
      timezone: GCAL_TIMEZONE,
      meetings: (calendar.events || []).length,
      totalMinutes,
      densityLevel,
      slotLoad,
    },
    error: null,
  });
});

app.get('/api/v1/insights/weekly', (req, res) => {
  const endDate = String(req.query.endDate || todayStr());
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(`${endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);

    const { start, end } = getDayUtcRange(date, GCAL_TIMEZONE);
    const sessions = db.prepare('SELECT * FROM sessions WHERE start_at >= ? AND start_at < ?').all(start, end);
    const checkins = getCheckinsMap(date);
    let mismatchCount = 0;
    let highEnergyDone = 0;
    let highEnergyTotal = 0;

    for (const s of sessions) {
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(s.task_id);
      if (!task) continue;
      const slot = toSlotByDateTime(s.start_at, GCAL_TIMEZONE);
      const slotEnergy = checkins[slot]?.energy ?? (slot === 'morning' ? 4 : slot === 'noon' ? 3 : 2);
      if (task.energy_demand >= 4) {
        highEnergyTotal += 1;
        if (s.end_at) highEnergyDone += 1;
      }
      if (task.energy_demand >= 4 && slotEnergy <= 2) mismatchCount += 1;
    }

    const mismatchRate = sessions.length ? Number((mismatchCount / sessions.length).toFixed(2)) : 0;
    const highEnergyCompletionRate = highEnergyTotal ? Number((highEnergyDone / highEnergyTotal).toFixed(2)) : 0;
    out.push({ date, mismatchRate, highEnergyCompletionRate, sessions: sessions.length });
  }

  res.json({ data: out, error: null });
});

app.get('/api/v1/health', (_req, res) => res.json({ data: { ok: true, timezone: GCAL_TIMEZONE }, error: null }));

app.listen(PORT, () => {
  console.log(`Energy app running on http://localhost:${PORT}`);
});
