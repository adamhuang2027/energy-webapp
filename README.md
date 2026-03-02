# EnerFlow Web App (v0.1)

A locally runnable MVP for **Time + Energy Management**: Plan → Execute → Review.

## 1) Implemented Features

- Task management (energy demand / focus type / importance)
- Daily energy check-ins (morning / noon / evening)
- Rule-based auto scheduling (match task energy demand to energy windows)
- Execution tracking (start/end session, record actual energy cost and reason tags)
- Night review (weighted completion rate, mismatch count, next-day suggestion)

## 2) Run Locally

```bash
cd /home/adam/.openclaw/workspace/energy-webapp
npm install
npm start
```

Open: `http://localhost:8787`

## 3) Task Breakdown (0 to usable app)

### Phase A — Foundation (Completed)
1. Initialize Node/Express project
2. Create SQLite schema (`tasks/checkins/sessions/reviews`)
3. Implement core REST API routes

### Phase B — Core Loop (Completed)
1. Plan: task creation + three-slot energy input
2. Scheduling: rule engine generates recommendations and supports apply
3. Now: one-click start/end session, capture actual energy cost
4. Review: auto-generate daily review metrics

### Phase C — Usability (Completed)
1. Single-page Web UI (Plan/Now/Review tabs)
2. Core actions completed in 1–2 clicks
3. Health check + basic error handling

## 4) API Endpoints

- `GET /api/v1/health`
- `GET/POST/PATCH /api/v1/tasks`
- `GET/POST /api/v1/energy-checkins`
- `POST /api/v1/sessions/start`
- `POST /api/v1/sessions/:id/end`
- `GET /api/v1/sessions`
- `POST /api/v1/schedule/generate`
- `POST /api/v1/schedule/apply`
- `GET /api/v1/review/daily`

## 5) v0.2 Features Added

1. Google Calendar meeting-density endpoint + schedule-aware meeting load
2. Weekly trend insights endpoint (mismatch rate / high-energy completion)
3. Smarter scheduling (switch-cost penalty + dynamic block sizing + recovery blocks)

### Google Calendar Setup (optional)

Set environment variables before startup:

```bash
export GCAL_API_KEY="your_google_api_key"
export GCAL_CALENDAR_ID="your_calendar_id@group.calendar.google.com"
export GCAL_TIMEZONE="America/Chicago"
npm start
```

If not set, the app still works and returns a friendly "not active" calendar status.

## 6) Next Steps (v0.3)

1. OAuth-based Google account authorization (instead of API key + calendarId)
2. Visual chart components for trends (line/bar)
3. User auth (JWT) and multi-device sync
