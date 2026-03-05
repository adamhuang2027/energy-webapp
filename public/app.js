const api = {
  getTasks: () => fetch('/api/v1/tasks').then(r => r.json()),
  createTask: (body) => fetch('/api/v1/tasks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  patchTask: (id, body) => fetch(`/api/v1/tasks/${id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  getCheckins: (date) => fetch(`/api/v1/energy-checkins?date=${date}`).then(r => r.json()),
  upsertCheckin: (body) => fetch('/api/v1/energy-checkins', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  generateSchedule: (body) => fetch('/api/v1/schedule/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  applySchedule: (body) => fetch('/api/v1/schedule/apply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  startSession: (body) => fetch('/api/v1/sessions/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  pauseSession: (id, body = {}) => fetch(`/api/v1/sessions/${id}/pause`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  resumeSession: (id, body = {}) => fetch(`/api/v1/sessions/${id}/resume`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  endSession: (id, body) => fetch(`/api/v1/sessions/${id}/end`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  getSessions: (date) => fetch(`/api/v1/sessions?date=${date}`).then(r => r.json()),
  getRunningSession: async () => {
    try {
      const r = await fetch('/api/v1/sessions/running');
      if (!r.ok) return { data: null, error: `HTTP_${r.status}` };
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { data: null, error: 'NON_JSON' };
      return await r.json();
    } catch {
      return { data: null, error: 'NETWORK' };
    }
  },
  getReview: (date) => fetch(`/api/v1/review/daily?date=${date}`).then(r => r.json()),
  getMeetingDensity: (date) => fetch(`/api/v1/calendar/meeting-density?date=${date}`).then(r => r.json()),
  getWeeklyInsights: (endDate) => fetch(`/api/v1/insights/weekly?endDate=${endDate}`).then(r => r.json()),
  getGoogleStatus: () => fetch('/api/v1/oauth/google/status').then(r => r.json()),
  disconnectGoogle: () => fetch('/api/v1/oauth/google/logout', { method: 'POST' }).then(r => r.json())
};

const CT_TZ = 'America/Chicago';

function dateStrInTimezone(date = new Date(), timeZone = CT_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getTodayCT() {
  return dateStrInTimezone(new Date(), CT_TZ);
}
let latestRecommendations = [];
let latestCalendar = null;
let runningSessionId = null;
let focusTimerInterval = null;
let autoRegenerate = localStorage.getItem('autoRegenerate') !== 'false';

const SLOT_CONFIG = {
  morning: { suggested: '09:00 CT', window: '07:00–11:00 CT' },
  noon: { suggested: '14:00 CT', window: '11:00–17:00 CT' },
  evening: { suggested: '21:00 CT', window: '17:00–24:00 CT' }
};

function qs(id){ return document.getElementById(id); }

function formatTimeCT(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

function formatDateTimeCT(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TZ,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

const focusLabel = { deep: 'Deep Work', shallow: 'Light Work', social: 'Communication' };
const importanceLabel = { normal: 'Normal', mit: 'Top Priority' };
const modeLabel = { flexible: 'Flexible', fixed: 'Fixed Time', windowed: 'Time Window' };
const statusLabel = { todo: 'To Do', done: 'Done' };

function isoToLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputValueToIso(val) {
  return val ? new Date(val).toISOString() : null;
}

function secondsToHHMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function renderFocusTimer(session) {
  const el = qs('focusTimer');
  if (!session) {
    if (focusTimerInterval) clearInterval(focusTimerInterval);
    focusTimerInterval = null;
    el.textContent = 'Focus time: 00:00:00';
    return;
  }

  if (focusTimerInterval) clearInterval(focusTimerInterval);

  const tick = () => {
    const startMs = new Date(session.start_at).getTime();
    const nowMs = Date.now();
    const pausedMsStored = (session.total_paused_minutes || 0) * 60 * 1000;

    let extraPausedMs = 0;
    if (session.paused_at) {
      extraPausedMs = Math.max(0, nowMs - new Date(session.paused_at).getTime());
    }

    const activeMs = Math.max(0, nowMs - startMs - pausedMsStored - extraPausedMs);
    const label = session.paused_at ? 'Focus time (paused)' : 'Focus time';
    el.textContent = `${label}: ${secondsToHHMMSS(activeMs / 1000)}`;
  };

  tick();
  focusTimerInterval = setInterval(tick, 1000);
}

function getCurrentSlotCT() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour')?.value || '0');
  if (h >= 7 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'noon';
  if (h >= 17 && h <= 23) return 'evening';
  return null;
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === name));
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

async function renderTasks() {
  const res = await api.getTasks();
  const tasks = res.data || [];
  const taskList = qs('taskList');
  const startSelect = qs('startTaskSelect');
  taskList.innerHTML = '';
  startSelect.innerHTML = '';

  for (const t of tasks) {
    const div = document.createElement('div');
    div.className = 'task-item';
    div.innerHTML = `
      <div class="task-head">
        <b>${t.title}</b>
        <div class="task-badges">
          <span class="badge">E${t.energy_demand}</span>
          <span class="badge">${focusLabel[t.focus_type] || t.focus_type}</span>
          <span class="badge">${importanceLabel[t.importance] || t.importance}</span>
          <span class="badge">${statusLabel[t.status] || t.status}</span>
          <span class="badge">${modeLabel[t.schedule_mode || 'flexible'] || (t.schedule_mode || 'flexible')}</span>
        </div>
      </div>
      <div class="muted">Scheduled: ${formatDateTimeCT(t.scheduled_start)} ~ ${formatDateTimeCT(t.scheduled_end)}</div>
      <div class="muted">Constraint: ${formatDateTimeCT(t.fixed_start)} ~ ${formatDateTimeCT(t.fixed_end)} | Window ${t.window_start_hour ?? '-'} - ${t.window_end_hour ?? '-'} (CT)</div>

      <div class="row" style="margin-top:8px">
        <button class="success" data-id="${t.id}" data-done="1">Mark Done</button>
      </div>

      <details class="task-advanced">
        <summary>Advanced Edit</summary>
        <div class="row" style="margin-top:8px">
          <label style="font-size:12px;color:#94a3b8">Energy Demand</label>
          <select id="energy-${t.id}">
            <option value="1" ${t.energy_demand === 1 ? 'selected' : ''}>1</option>
            <option value="2" ${t.energy_demand === 2 ? 'selected' : ''}>2</option>
            <option value="3" ${t.energy_demand === 3 ? 'selected' : ''}>3</option>
            <option value="4" ${t.energy_demand === 4 ? 'selected' : ''}>4</option>
            <option value="5" ${t.energy_demand === 5 ? 'selected' : ''}>5</option>
          </select>
          <label style="font-size:12px;color:#94a3b8">Focus Type</label>
          <select id="focus-${t.id}">
            <option value="deep" ${t.focus_type === 'deep' ? 'selected' : ''}>Deep Work</option>
            <option value="shallow" ${t.focus_type === 'shallow' ? 'selected' : ''}>Light Work</option>
            <option value="social" ${t.focus_type === 'social' ? 'selected' : ''}>Communication</option>
          </select>
          <label style="font-size:12px;color:#94a3b8">Mode</label>
          <select id="mode-${t.id}">
            <option value="flexible" ${(t.schedule_mode || 'flexible') === 'flexible' ? 'selected' : ''}>Flexible</option>
            <option value="fixed" ${t.schedule_mode === 'fixed' ? 'selected' : ''}>Fixed Time</option>
            <option value="windowed" ${t.schedule_mode === 'windowed' ? 'selected' : ''}>Time Window</option>
          </select>
          <input id="wstart-${t.id}" type="number" min="0" max="23" value="${t.window_start_hour ?? ''}" placeholder="win start" style="width:90px" />
          <input id="wend-${t.id}" type="number" min="1" max="24" value="${t.window_end_hour ?? ''}" placeholder="win end" style="width:90px" />
          <input id="fstart-${t.id}" type="datetime-local" value="${isoToLocalInputValue(t.fixed_start)}" style="min-width:190px" />
          <input id="fend-${t.id}" type="datetime-local" value="${isoToLocalInputValue(t.fixed_end)}" style="min-width:190px" />
          <button class="secondary" data-id="${t.id}" data-action="save-task-meta">Save</button>
        </div>
      </details>
    `;
    div.querySelector('[data-action="save-task-meta"]').addEventListener('click', async () => {
      const energyDemand = Number(div.querySelector(`#energy-${t.id}`).value);
      const focusType = div.querySelector(`#focus-${t.id}`).value;
      const scheduleMode = div.querySelector(`#mode-${t.id}`).value;
      const windowStartHourRaw = div.querySelector(`#wstart-${t.id}`).value;
      const windowEndHourRaw = div.querySelector(`#wend-${t.id}`).value;
      const fixedStartRaw = div.querySelector(`#fstart-${t.id}`).value;
      const fixedEndRaw = div.querySelector(`#fend-${t.id}`).value;
      const windowStartHour = windowStartHourRaw === '' ? null : Number(windowStartHourRaw);
      const windowEndHour = windowEndHourRaw === '' ? null : Number(windowEndHourRaw);
      const fixedStart = localInputValueToIso(fixedStartRaw);
      const fixedEnd = localInputValueToIso(fixedEndRaw);
      const resp = await api.patchTask(t.id, { energyDemand, focusType, scheduleMode, windowStartHour, windowEndHour, fixedStart, fixedEnd });
      if (resp.error) return alert(resp.error);
      await refreshAll();
    });
    div.querySelector('[data-done="1"]').addEventListener('click', async () => {
      await api.patchTask(t.id, { status: 'done' });
      await refreshAll();
    });
    taskList.appendChild(div);

    if (t.status !== 'done') {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.title} (E${t.energy_demand})`;
      startSelect.appendChild(opt);
    }
  }
}

async function renderCheckins() {
  const res = await api.getCheckins(getTodayCT());
  const rows = res.data || [];
  const map = Object.fromEntries(rows.map(r => [r.slot, r]));
  const container = qs('checkinContainer');
  const hint = qs('checkinHint');
  container.innerHTML = '';

  const currentSlot = getCurrentSlotCT();
  hint.textContent = currentSlot
    ? `Current slot (Central Time): ${currentSlot}. Suggested check-in time: ${SLOT_CONFIG[currentSlot].suggested} (window ${SLOT_CONFIG[currentSlot].window}).`
    : 'Current time (Central Time) is outside suggested check-in windows. You can still backfill any slot below.';

  ['morning','noon','evening'].forEach(slot => {
    const row = map[slot] || {};
    const isCurrent = slot === currentSlot;
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `
      <span style="width:90px">${slot}</span>
      <span style="font-size:12px;color:#94a3b8">suggested: ${SLOT_CONFIG[slot].suggested}</span>
      <span style="font-size:12px;color:#94a3b8">window: ${SLOT_CONFIG[slot].window}</span>
      <input type="number" min="1" max="5" value="${row.energy || 3}" id="${slot}-energy" title="Energy" />
      <input type="number" min="1" max="5" value="${row.focus || 3}" id="${slot}-focus" title="Focus" />
      <input type="number" min="1" max="5" value="${row.mood || 3}" id="${slot}-mood" title="Mood" />
      <button id="save-${slot}">${isCurrent ? 'Save (Current Slot)' : 'Save'}</button>
    `;
    container.appendChild(div);
    div.querySelector(`#save-${slot}`).addEventListener('click', async () => {
      await api.upsertCheckin({
        date: getTodayCT(),
        slot,
        energy: Number(div.querySelector(`#${slot}-energy`).value),
        focus: Number(div.querySelector(`#${slot}-focus`).value),
        mood: Number(div.querySelector(`#${slot}-mood`).value),
      });
      await refreshSchedulePreview();
      if (!isCurrent) {
        alert(`${slot} saved. Friendly note: this is outside your current slot, but backfill is allowed.`);
      } else {
        alert(`${slot} saved`);
      }
    });
  });
}

async function refreshSchedulePreview() {
  const strategy = qs('strategy').value;
  const res = await api.generateSchedule({ date: getTodayCT(), strategy, includeCalendar: true });
  const data = res.data || { windows: [], recommendations: [], calendar: null };
  latestRecommendations = data.recommendations || [];
  latestCalendar = data.calendar || null;

  qs('windows').innerHTML = data.windows.map(w =>
    `<div class="badge ${w.energyLevel}">${w.slot}: ${w.energyLevel} (E${w.energy}) · meetings ${w.meetingMinutes || 0}m · avail ${w.availableMinutes || '-'}m</div>`
  ).join('');

  const calText = latestCalendar
    ? (latestCalendar.enabled
      ? `Google Calendar: ${latestCalendar.meetingCount} meetings. Slot load (min) — morning ${latestCalendar.meetingLoad.morning}, noon ${latestCalendar.meetingLoad.noon}, evening ${latestCalendar.meetingLoad.evening}.`
      : `Google Calendar not active: ${latestCalendar.reason}`)
    : 'Google Calendar status unavailable';
  qs('meetingDensity').textContent = calText;

  qs('recommendations').innerHTML = latestRecommendations.map(r => `
    <div class="rec-item">
      <b>${r.title}</b> → ${r.slot}
      <div>Time (CT): ${formatTimeCT(r.start)} - ${formatTimeCT(r.end)}</div>
      <div>Duration: ${r.duration || '-'} mins · Match Score: ${r.matchScore}</div>
      <div>${r.reason}</div>
    </div>
  `).join('') || 'No recommendations yet';
}

async function renderSessions() {
  const res = await api.getSessions(getTodayCT());
  const list = res.data || [];
  const container = qs('sessionList');
  container.innerHTML = '';

  let running = list.find(s => !s.end_at) || null;
  if (!running) {
    const runningRes = await api.getRunningSession();
    running = runningRes.data || null;
  }

  runningSessionId = running?.id || null;
  const isPaused = Boolean(running?.paused_at);
  const runningInfoEl = qs('runningInfo');
  runningInfoEl.textContent = running
    ? `${isPaused ? '⏸️ Paused' : '🟢 Running'} session #${running.id} · task #${running.task_id} · started ${new Date(running.start_at).toLocaleTimeString()}`
    : '⚪ No running task right now';
  runningInfoEl.style.borderColor = running ? (isPaused ? 'rgba(245, 158, 11, 0.7)' : 'rgba(34, 197, 94, 0.6)') : '#38527a';
  runningInfoEl.style.background = running ? (isPaused ? 'rgba(245, 158, 11, 0.10)' : 'rgba(34, 197, 94, 0.08)') : '#0f1a2f';

  qs('btnPause').disabled = !running || isPaused;
  qs('btnResume').disabled = !running || !isPaused;
  qs('btnStart').disabled = Boolean(running);

  renderFocusTimer(running);

  list.forEach(s => {
    const div = document.createElement('div');
    div.className = `session-item ${(!s.end_at || (running && running.id === s.id)) ? 'running' : ''}`;
    div.innerHTML = `
      <b>Session #${s.id}</b> task#${s.task_id}
      <div>${new Date(s.start_at).toLocaleTimeString()} - ${s.end_at ? new Date(s.end_at).toLocaleTimeString() : (s.paused_at ? 'paused...' : 'running...')}</div>
      <div>duration: ${s.duration_minutes || '-'} mins, paused: ${s.total_paused_minutes || 0} mins, energyCost: ${s.actual_energy_cost || '-'}</div>
      <div class="muted" style="margin-top:4px">details: ${s.session_details ? s.session_details : '-'}</div>
    `;
    container.appendChild(div);
  });
}

async function renderReview() {
  const res = await api.getReview(getTodayCT());
  const d = res.data;
  qs('reviewCard').innerHTML = `
    <div>Date: ${d.review_date}</div>
    <div>Weighted Completion Rate: ${(d.weighted_completion_rate * 100).toFixed(1)}%</div>
    <div>Mismatch Count: ${d.mismatch_count}</div>
    <div>Energy Debt Score: ${d.debt_score}</div>
    <div><b>Suggestion for Tomorrow:</b> ${d.suggestion_text}</div>
  `;
}

async function renderWeeklyTrends() {
  const res = await api.getWeeklyInsights(getTodayCT());
  const rows = res.data || [];
  const el = qs('weeklyTrends');
  el.innerHTML = rows.map(r => {
    const mismatchPct = Math.round((r.mismatchRate || 0) * 100);
    const highEnergyPct = Math.round((r.highEnergyCompletionRate || 0) * 100);
    return `<div class="rec-item">
      <div><b>${r.date}</b></div>
      <div>Mismatch Rate: ${mismatchPct}%</div>
      <div>High-Energy Completion: ${highEnergyPct}%</div>
      <div>Sessions: ${r.sessions}</div>
    </div>`;
  }).join('') || 'No weekly trend data yet';
}

async function renderGoogleStatus() {
  const res = await api.getGoogleStatus();
  const d = res.data;
  qs('googleStatus').textContent = d.connected
    ? `Google OAuth connected. Calendar: ${d.calendarId}. Timezone: ${d.timezone}`
    : (d.oauthConfigured
      ? `Google OAuth configured but not connected. Click "Connect Google Calendar (OAuth)".`
      : 'Google OAuth not configured on server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
}

qs('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = qs('scheduleMode').value;
  const fixedStartVal = qs('fixedStart').value;
  const fixedEndVal = qs('fixedEnd').value;
  const body = {
    title: qs('title').value,
    estimatedMinutes: qs('estimatedMinutes').value ? Number(qs('estimatedMinutes').value) : undefined,
    energyDemand: Number(qs('energyDemand').value),
    focusType: qs('focusType').value,
    importance: qs('importance').value,
    scheduleMode: mode,
    fixedStart: fixedStartVal ? new Date(fixedStartVal).toISOString() : null,
    fixedEnd: fixedEndVal ? new Date(fixedEndVal).toISOString() : null,
    windowStartHour: qs('windowStartHour').value ? Number(qs('windowStartHour').value) : null,
    windowEndHour: qs('windowEndHour').value ? Number(qs('windowEndHour').value) : null,
  };
  const res = await api.createTask(body);
  if (res.error) return alert(res.error);
  qs('taskForm').reset();
  await refreshAll();
});

qs('autoRegenerateToggle').checked = autoRegenerate;
qs('autoRegenerateToggle').addEventListener('change', (e) => {
  autoRegenerate = e.target.checked;
  localStorage.setItem('autoRegenerate', String(autoRegenerate));
});

qs('btnConnectGoogle').addEventListener('click', () => {
  window.location.href = '/api/v1/oauth/google/start';
});

qs('btnDisconnectGoogle').addEventListener('click', async () => {
  await api.disconnectGoogle();
  await renderGoogleStatus();
  qs('meetingDensity').textContent = 'Google disconnected.';
});

qs('btnLoadCalendar').addEventListener('click', async () => {
  const res = await api.getMeetingDensity(getTodayCT());
  const d = res.data;
  qs('meetingDensity').textContent = d.enabled
    ? `Google Calendar loaded (${d.timezone}): ${d.meetings} meetings, total ${d.totalMinutes} mins, density ${d.densityLevel}.`
    : `Google Calendar not active: ${d.reason}`;
});

qs('btnGenerate').addEventListener('click', refreshSchedulePreview);
qs('btnApply').addEventListener('click', async () => {
  if (!latestRecommendations.length) return alert('Generate a schedule first');
  await api.applySchedule({ date: getTodayCT(), recommendations: latestRecommendations.map(r => ({ taskId: r.taskId, start: r.start, end: r.end })) });
  await refreshAll();
  alert('Schedule applied');
});

qs('btnStart').addEventListener('click', async () => {
  const taskId = Number(qs('startTaskSelect').value);
  if (!taskId) return alert('Please select a task first');
  const res = await api.startSession({ taskId });
  if (res.error) return alert(res.error);
  await refreshAll();
  setTimeout(() => { renderSessions(); }, 250);
});

qs('btnPause').addEventListener('click', async () => {
  if (!runningSessionId) return alert('There is no running session right now');
  const res = await api.pauseSession(runningSessionId);
  if (res.error) return alert(res.error);
  await renderSessions();
});

qs('btnResume').addEventListener('click', async () => {
  if (!runningSessionId) return alert('There is no paused session right now');
  const res = await api.resumeSession(runningSessionId);
  if (res.error) return alert(res.error);
  await renderSessions();
});

qs('btnEnd').addEventListener('click', async () => {
  if (!runningSessionId) return alert('There is no running session right now');
  const sessionDetails = qs('sessionDetails').value.trim();
  const res = await api.endSession(runningSessionId, {
    actualEnergyCost: Number(qs('energyCost').value),
    sessionDetails,
    interruptionsCount: 0,
    markDone: true,
  });
  if (res.error) return alert(res.error);
  qs('sessionDetails').value = '';
  await refreshAll();
});

qs('btnRefreshReview').addEventListener('click', async () => {
  await renderReview();
  await renderWeeklyTrends();
});

async function refreshAll({ regenerate = autoRegenerate } = {}) {
  await renderGoogleStatus();
  await renderTasks();
  await renderCheckins();
  if (regenerate) await refreshSchedulePreview();
  await renderSessions();
  await renderReview();
  await renderWeeklyTrends();
}

refreshAll();
