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

## 5) Next Steps (v0.2)

1. Integrate Google Calendar (automatic meeting density)
2. Add weekly trend charts (mismatch rate / high-energy task completion rate)
3. Improve scheduling algorithm (context-switch cost + dynamic block sizing)
4. Add user auth (JWT) and multi-device sync
