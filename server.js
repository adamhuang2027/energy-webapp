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

function toSlotByHourUTC(hour) {
  if (hour >= 9 && hour < 12) return 'morning';
  if (hour >= 13 && hour < 18) return 'noon';
  return 'evening';
}

function getSlotMeetingLoad(events = []) {
  const slotLoad = { morning: 0, noon: 0, evening: 0 };
  for (const e of events) {
    const start = new Date(e.start.dateTime || e.start.date);
    const end = new Date(e.end.dateTime || e.end.date);
    const durationMin = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
    const slot = toSlotByHourUTC(start.getUTCHours());
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
  const timeMin = `${date}T00:00:00Z`;
  const timeMax = `${date}T23:59:59Z`;

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

  const checkins = getCheckinsMap(date);
  const baseCurve = {
    morning: checkins.morning?.energy ?? 4,
    noon: checkins.noon?.energy ?? 3,
    evening: checkins.evening?.energy ?? 2,
  };

  if (strategy === 'sprint') baseCurve.morning = Math.min(5, baseCurve.morning + 1);
  if (strategy === 'conservative') baseCurve.evening = Math.max(1, baseCurve.evening - 1);

  const windows = [
    { slot: 'morning', start: `${date}T09:00:00Z`, end: `${date}T12:00:00Z`, energy: baseCurve.morning, cursorMin: 0, lengthMin: 180 },
    { slot: 'noon', start: `${date}T13:30:00Z`, end: `${date}T17:30:00Z`, energy: baseCurve.noon, cursorMin: 0, lengthMin: 240 },
    { slot: 'evening', start: `${date}T20:00:00Z`, end: `${date}T22:00:00Z`, energy: baseCurve.evening, cursorMin: 0, lengthMin: 120 },
  ].map(w => ({ ...w, availableMin: Math.max(30, w.lengthMin - Math.min(w.lengthMin - 30, meetingLoad[w.slot] || 0)) }));

  const recommendations = [];
  let lastFocusType = null;
  let lastDevice = null;

  for (const task of tasks) {
    const idealDuration = task.estimated_minutes || (task.energy_demand >= 4 ? 90 : task.energy_demand <= 2 ? 30 : 50);
    const maxBlock = strategy === 'sprint' ? 120 : strategy === 'conservative' ? 60 : 90;
    const minBlock = task.energy_demand >= 4 ? 45 : 25;
    const duration = Math.max(minBlock, Math.min(maxBlock, idealDuration));

    let best = null;
    for (const w of windows) {
      const remains = w.availableMin - w.cursorMin;
      if (remains < duration) continue;

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
      (meetingLoad[best.w.slot] || 0) > 0 ? `meeting load ${meetingLoad[best.w.slot]}m` : 'light meeting load'
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
    });

    lastFocusType = task.focus_type;
    lastDevice = task.context_device || lastDevice;

    if (best.w.cursorMin >= 90) {
      best.w.cursorMin += 10; // insert a recovery block
    }
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

    const sessions = db.prepare('SELECT * FROM sessions WHERE date(start_at)=?').all(date);
    const checkins = getCheckinsMap(date);
    let mismatchCount = 0;
    let highEnergyDone = 0;
    let highEnergyTotal = 0;

    for (const s of sessions) {
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(s.task_id);
      if (!task) continue;
      const slot = toSlotByHourUTC(new Date(s.start_at).getUTCHours());
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
