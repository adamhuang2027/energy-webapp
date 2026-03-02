const api = {
  getTasks: () => fetch('/api/v1/tasks').then(r => r.json()),
  createTask: (body) => fetch('/api/v1/tasks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  patchTask: (id, body) => fetch(`/api/v1/tasks/${id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  getCheckins: (date) => fetch(`/api/v1/energy-checkins?date=${date}`).then(r => r.json()),
  upsertCheckin: (body) => fetch('/api/v1/energy-checkins', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  generateSchedule: (body) => fetch('/api/v1/schedule/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  applySchedule: (body) => fetch('/api/v1/schedule/apply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  startSession: (body) => fetch('/api/v1/sessions/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  endSession: (id, body) => fetch(`/api/v1/sessions/${id}/end`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(r => r.json()),
  getSessions: (date) => fetch(`/api/v1/sessions?date=${date}`).then(r => r.json()),
  getReview: (date) => fetch(`/api/v1/review/daily?date=${date}`).then(r => r.json())
};

const today = new Date().toISOString().slice(0,10);
let latestRecommendations = [];
let runningSessionId = null;

function qs(id){ return document.getElementById(id); }

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
      <b>${t.title}</b>
      <span class="badge">E${t.energy_demand}</span>
      <span class="badge">${t.focus_type}</span>
      <span class="badge">${t.importance}</span>
      <span class="badge">${t.status}</span>
      <div>scheduled: ${t.scheduled_start || '-'} ~ ${t.scheduled_end || '-'}</div>
      <button data-id="${t.id}" data-done="1">Mark Done</button>
    `;
    div.querySelector('button').addEventListener('click', async () => {
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
  const res = await api.getCheckins(today);
  const rows = res.data || [];
  const map = Object.fromEntries(rows.map(r => [r.slot, r]));
  const container = qs('checkinContainer');
  container.innerHTML = '';

  ['morning','noon','evening'].forEach(slot => {
    const row = map[slot] || {};
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `
      <span style="width:70px">${slot}</span>
      <input type="number" min="1" max="5" value="${row.energy || 3}" id="${slot}-energy" />
      <input type="number" min="1" max="5" value="${row.focus || 3}" id="${slot}-focus" />
      <input type="number" min="1" max="5" value="${row.mood || 3}" id="${slot}-mood" />
      <button id="save-${slot}">Save</button>
    `;
    container.appendChild(div);
    div.querySelector(`#save-${slot}`).addEventListener('click', async () => {
      await api.upsertCheckin({
        date: today,
        slot,
        energy: Number(div.querySelector(`#${slot}-energy`).value),
        focus: Number(div.querySelector(`#${slot}-focus`).value),
        mood: Number(div.querySelector(`#${slot}-mood`).value),
      });
      await refreshSchedulePreview();
      alert(`${slot} saved`);
    });
  });
}

async function refreshSchedulePreview() {
  const strategy = qs('strategy').value;
  const res = await api.generateSchedule({ date: today, strategy });
  const data = res.data || { windows: [], recommendations: [] };
  latestRecommendations = data.recommendations || [];

  qs('windows').innerHTML = data.windows.map(w =>
    `<div class="badge ${w.energyLevel}">${w.slot}: ${w.energyLevel} (E${w.energy})</div>`
  ).join('');

  qs('recommendations').innerHTML = latestRecommendations.map(r => `
    <div class="rec-item">
      <b>${r.title}</b> → ${r.slot}
      <div>Time: ${new Date(r.start).toLocaleTimeString()} - ${new Date(r.end).toLocaleTimeString()}</div>
      <div>Match Score: ${r.matchScore}</div>
      <div>${r.reason}</div>
    </div>
  `).join('') || 'No recommendations yet';
}

async function renderSessions() {
  const res = await api.getSessions(today);
  const list = res.data || [];
  const container = qs('sessionList');
  container.innerHTML = '';

  const running = list.find(s => !s.end_at);
  runningSessionId = running?.id || null;
  qs('runningInfo').textContent = running
    ? `Running session #${running.id} task #${running.task_id} started: ${new Date(running.start_at).toLocaleTimeString()}`
    : 'No running task right now';

  list.forEach(s => {
    const div = document.createElement('div');
    div.className = 'session-item';
    div.innerHTML = `
      <b>Session #${s.id}</b> task#${s.task_id}
      <div>${new Date(s.start_at).toLocaleTimeString()} - ${s.end_at ? new Date(s.end_at).toLocaleTimeString() : 'running...'}</div>
      <div>duration: ${s.duration_minutes || '-'} mins, energyCost: ${s.actual_energy_cost || '-'}</div>
    `;
    container.appendChild(div);
  });
}

async function renderReview() {
  const res = await api.getReview(today);
  const d = res.data;
  qs('reviewCard').innerHTML = `
    <div>Date: ${d.review_date}</div>
    <div>Weighted Completion Rate: ${(d.weighted_completion_rate * 100).toFixed(1)}%</div>
    <div>Mismatch Count: ${d.mismatch_count}</div>
    <div>Energy Debt Score: ${d.debt_score}</div>
    <div><b>Suggestion for Tomorrow:</b> ${d.suggestion_text}</div>
  `;
}

qs('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    title: qs('title').value,
    estimatedMinutes: qs('estimatedMinutes').value ? Number(qs('estimatedMinutes').value) : undefined,
    energyDemand: Number(qs('energyDemand').value),
    focusType: qs('focusType').value,
    importance: qs('importance').value,
  };
  const res = await api.createTask(body);
  if (res.error) return alert(res.error);
  qs('taskForm').reset();
  await refreshAll();
});

qs('btnGenerate').addEventListener('click', refreshSchedulePreview);
qs('btnApply').addEventListener('click', async () => {
  if (!latestRecommendations.length) return alert('Generate a schedule first');
  await api.applySchedule({ date: today, recommendations: latestRecommendations.map(r => ({ taskId: r.taskId, start: r.start, end: r.end })) });
  await refreshAll();
  alert('Schedule applied');
});

qs('btnStart').addEventListener('click', async () => {
  const taskId = Number(qs('startTaskSelect').value);
  if (!taskId) return alert('Please select a task first');
  const res = await api.startSession({ taskId });
  if (res.error) return alert(res.error);
  await refreshAll();
});

qs('btnEnd').addEventListener('click', async () => {
  if (!runningSessionId) return alert('There is no running session right now');
  const reasonTags = qs('reasonTags').value.split(',').map(s => s.trim()).filter(Boolean);
  const res = await api.endSession(runningSessionId, {
    actualEnergyCost: Number(qs('energyCost').value),
    reasonTags,
    interruptionsCount: 0,
    markDone: true,
  });
  if (res.error) return alert(res.error);
  qs('reasonTags').value = '';
  await refreshAll();
});

qs('btnRefreshReview').addEventListener('click', renderReview);

async function refreshAll() {
  await renderTasks();
  await renderCheckins();
  await refreshSchedulePreview();
  await renderSessions();
  await renderReview();
}

refreshAll();
