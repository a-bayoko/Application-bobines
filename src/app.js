import { SHIFTS, cycleDurationMs, formatDuration, formatClock, getShiftWindow, projectCycles, activeCycle, resolveManualTime } from './calculations.js';

const KEY = 'application-bobines-v1';
const STOP_REASONS = ['Panne machine', 'Réglage', 'Changement matière', 'Contrôle qualité', 'Manque matière', 'Autre'];
const WASTE_CODES = [
  ['D1', 'Zip ouvert'],
  ['D2', 'Défaut d’enroulement'],
  ['D3', 'Zip cassé'],
  ['D4', 'Défaut dimensionnel'],
  ['D5', 'Présence de particule'],
  ['D6', 'Force d’ouverture'],
  ['D7', 'Autre (CS, etc.)'],
  ['D8', 'Nettoyage filière'],
  ['DC', 'Coupe du voile'],
  ['RR', 'Déchet de réglage']
];
const $ = (s) => document.querySelector(s);
const now = () => Date.now();
function migrate(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  return {
    shiftId: base.shiftId || 'morning',
    operatorNumber: String(base.operatorNumber || '1073'),
    events: Array.isArray(base.events) ? base.events : [],
    lines: Array.isArray(base.lines) ? base.lines.map((line) => ({
      ...line,
      productionHistory: Array.isArray(line.productionHistory) ? line.productionHistory : [],
      production: line.production || (line.startAt ? { id: crypto.randomUUID(), startAt: line.startAt, pauses: [], endAt: null } : null)
    })) : []
  };
}
let state = migrate(JSON.parse(localStorage.getItem(KEY) || 'null'));
let editingId = null; let installPrompt; let pendingEvent = null; let pendingWaste = null; let selectedWaste = null;
const save = () => localStorage.setItem(KEY, JSON.stringify(state));
const lineById = (id) => state.lines.find((line) => line.id === id);
function eventFor(line, type, declaredAt, extra = {}) {
  state.events.push({ id: crypto.randomUUID(), recordedAt: now(), declaredAt, type, lineId: line.id, lineNumber: line.lineNumber, operatorNumber: state.operatorNumber, production: { length: line.length, speed: line.speed, coilsPerCycle: line.coilsPerCycle }, ...extra });
}
function currentProduction(line) { return line.production || (line.startAt ? { id: crypto.randomUUID(), startAt: line.startAt, pauses: [], endAt: null } : null); }
function currentWindow() { return getShiftWindow(state.shiftId); }
function withinShift(at = now()) { const w = currentWindow(); return at >= w.start.getTime() && at <= w.end.getTime(); }
function sessionEnded(production, window, at = now()) { return Boolean(production && at >= window.end.getTime()); }

function render() {
  const window = currentWindow(); const currentTime = now();
  $('#shift-range').textContent = `${formatClock(window.start)} → ${formatClock(window.end)}`;
  $('#operator-number').value = state.operatorNumber;
  $('#shift-options').innerHTML = SHIFTS.map((shift) => `<button class="shift-option ${shift.id === state.shiftId ? 'selected' : ''}" data-shift="${shift.id}" role="radio" aria-checked="${shift.id === state.shiftId}">${shift.label}<small>${shift.start} → ${shift.end}</small></button>`).join('');
  const list = $('#line-list'); list.innerHTML = ''; $('#empty-state').hidden = state.lines.length > 0; $('.dashboard-columns').hidden = state.lines.length === 0;
  $('#dashboard-help').textContent = state.lines.length ? `${state.lines.length}/10 ligne${state.lines.length > 1 ? 's' : ''} · touchez une ligne pour les actions.` : 'Configurez une ligne pour commencer.';

  state.lines.forEach((line) => {
    const card = $('#line-card-template').content.firstElementChild.cloneNode(true);
    const duration = cycleDurationMs(line.length, line.speed); const production = currentProduction(line);
    const endedByShift = sessionEnded(production, window, currentTime); const paused = Boolean(production && !production.endAt && production.pausedAt);
    const cycle = production && !production.endAt && !endedByShift ? activeCycle(production, duration, window.end, currentTime) : null;
    card.dataset.id = line.id; card.querySelector('.line-name').textContent = `L${line.lineNumber}`;
    card.querySelector('.line-config').textContent = `${line.length} m · ${line.speed} m/min`;
    const stateLabel = card.querySelector('.line-state');
    if (!production) stateLabel.textContent = 'À démarrer';
    else if (production.endAt) stateLabel.textContent = 'OF terminé';
    else if (endedByShift) stateLabel.textContent = 'Poste terminé';
    else if (paused) stateLabel.textContent = 'En pause';
    else stateLabel.textContent = 'En production';

    if (cycle) {
      card.querySelector('.cycle-window').textContent = `${formatClock(cycle.start)} → ${formatClock(cycle.end)}`;
      card.querySelector('.progress-fill').style.width = `${cycle.progress.toFixed(1)}%`;
      card.querySelector('.progress-value').textContent = `${Math.round(cycle.progress)}%`;
    } else if (paused) {
      card.querySelector('.cycle-window').textContent = `Pause depuis ${formatClock(production.pausedAt)}`;
      card.querySelector('.progress-value').textContent = 'PAUSE';
    } else if (endedByShift) {
      card.querySelector('.cycle-window').textContent = `Relève ${formatClock(window.end)}`;
      card.querySelector('.progress-value').textContent = 'FIN';
    } else if (production?.endAt) {
      card.querySelector('.cycle-window').textContent = `OF fini ${formatClock(production.endAt)}`;
      card.querySelector('.progress-value').textContent = 'OF';
    }
    const quick = card.querySelector('.quick-start'); quick.hidden = Boolean(production);
    list.append(card);
  });
}

function openForm(line = null) {
  editingId = line?.id || null; const f = $('#line-form'); f.reset(); $('#line-error').hidden = true;
  $('#dialog-title').textContent = line ? `Modifier L${line.lineNumber}` : 'Configurer une ligne';
  $('#form-kicker').textContent = line ? 'PARAMÈTRES LIGNE' : 'NOUVELLE LIGNE'; $('#delete-line').hidden = !line;
  if (line) Object.entries(line).forEach(([key, value]) => f.elements[key] && (f.elements[key].value = value));
  updatePreview(); $('#line-dialog').showModal();
}
function updatePreview() {
  const f = $('#line-form');
  $('#duration-preview').textContent = f.elements.length.value > 0 && f.elements.speed.value > 0 ? `Durée calculée : ${formatDuration(cycleDurationMs(f.elements.length.value, f.elements.speed.value))}` : 'La durée du cycle apparaîtra ici.';
}
function openEvent(line, type) {
  pendingEvent = { line, type }; const form = $('#event-form'); form.reset(); $('#event-error').hidden = true;
  const labels = { startManual: 'Saisir l’heure de départ', correctStart: 'Corriger l’heure de départ', pause: 'Arrêt / pause', resume: 'Reprise', endOf: 'Fin d’OF' };
  $('#event-title').textContent = labels[type]; $('#event-kicker').textContent = `L${line.lineNumber} · OPÉRATEUR ${state.operatorNumber}`;
  $('#reason-label').hidden = type !== 'pause';
  $('#event-time-label').firstChild.textContent = type === 'correctStart' ? 'Nouvelle heure de départ' : 'Heure déclarée';
  form.elements.time.value = new Date().toTimeString().slice(0, 5); $('#event-dialog').showModal();
}
function start(line, declaredAt, type = 'start') {
  const window = currentWindow();
  if (declaredAt < window.start.getTime() || declaredAt > window.end.getTime()) throw new Error('Le départ doit appartenir au poste actif.');
  if (line.production?.endAt) line.productionHistory = [...(line.productionHistory || []), line.production];
  line.production = { id: crypto.randomUUID(), startAt: declaredAt, pauses: [], endAt: null }; line.startAt = declaredAt;
  eventFor(line, type, declaredAt); save(); render();
}
function openWaste(line) {
  pendingWaste = line; selectedWaste = null; $('#waste-kicker').textContent = `L${line.lineNumber} · OPÉRATEUR ${state.operatorNumber}`;
  $('#waste-step-codes').hidden = false; $('#waste-step-weight').hidden = true; $('#waste-error').hidden = true; $('#waste-form').elements.weight.value = '';
  $('#waste-codes').innerHTML = WASTE_CODES.map(([code, label]) => `<button type="button" class="waste-code" data-code="${code}"><strong>${code}</strong><span>${label}</span></button>`).join('');
  $('#waste-dialog').showModal();
}
function selectWaste(code) {
  selectedWaste = WASTE_CODES.find(([item]) => item === code); if (!selectedWaste) return;
  $('#waste-selected').innerHTML = `<strong>${selectedWaste[0]}</strong> — ${selectedWaste[1]}`;
  $('#waste-step-codes').hidden = true; $('#waste-step-weight').hidden = false; $('#waste-form').elements.weight.focus();
}
function showDetails(id) {
  const line = lineById(id); const production = currentProduction(line); if (!production) return openForm(line);
  const window = currentWindow(); const duration = cycleDurationMs(line.length, line.speed);
  const p = projectCycles({ startAt: production.startAt, durationMs: duration, shiftEnd: window.end, pauses: production.pauses || [], stoppedAt: production.endAt });
  const ended = sessionEnded(production, window); const paused = Boolean(!production.endAt && production.pausedAt); const active = !production.endAt && !ended;
  const actions = active ? `<div class="detail-actions">
    <button data-action="edit" class="secondary-button">⚙ CORRIGER</button>
    <button data-action="correct" class="secondary-button">🕒 CORRIGER DÉPART</button>
    ${paused ? '<button data-action="resume" class="resume-button">▶ REPRISE</button>' : '<button data-action="pause" class="pause-button">⏸ ARRÊT / PAUSE</button>'}
    <button data-action="complete" class="complete-button">✓ BOBINE TERMINÉE</button>
    <button data-action="waste" class="waste-button">⚖ DÉCLARER DÉCHET</button>
    <button data-action="endof" class="end-of-button">■ FIN D’OF</button>
  </div>` : `<div class="detail-actions"><button data-action="edit" class="secondary-button">⚙ CORRIGER</button>${production.endAt ? '<button data-action="newof" class="primary-button">▶ NOUVEL OF</button>' : ''}</div>`;
  $('#detail-content').innerHTML = `<div class="dialog-header"><div><p class="eyebrow">LIGNE EN COURS</p><h2>L${line.lineNumber}</h2></div><button class="close-button close-detail" aria-label="Fermer">×</button></div>
  <p class="detail-intro">${line.length} m · ${line.speed} m/min · ${line.coilsPerCycle} bobine(s)/cycle · durée ${formatDuration(duration)}</p>
  ${ended && !production.endAt ? `<p class="shift-ended">Poste terminé à ${formatClock(window.end)}. Aucun cycle finissant après la relève n’est compté pour cet opérateur.</p>` : ''}
  ${actions}
  <details class="projection-details"><summary>Voir la projection détaillée (${p.cycles.length} cycles)</summary><ol class="cycle-list">${p.cycles.map(c => `<li class="${c.highlighted ? `highlight ${c.status.className}` : ''}"><b>Cycle ${c.number}</b><span>${formatClock(c.start)} → ${formatClock(c.end)}</span></li>`).join('')}</ol></details>`;
  $('#detail-dialog').dataset.lineId = id; $('#detail-dialog').showModal();
}

$('#operator-number').addEventListener('change', (e) => { state.operatorNumber = e.target.value.trim() || '1073'; save(); render(); });
$('#shift-options').addEventListener('click', (e) => { const b = e.target.closest('[data-shift]'); if (b) { state.shiftId = b.dataset.shift; save(); render(); } });
$('#add-line').onclick = () => state.lines.length < 10 && openForm(); $('.add-line-action').onclick = () => openForm();
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $('#line-dialog').close(); $('#line-form').addEventListener('input', updatePreview);
$('#line-form').addEventListener('submit', (e) => {
  e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); const old = editingId && lineById(editingId); const number = Number(data.lineNumber);
  const duplicate = state.lines.find((x) => x.lineNumber === number && x.id !== editingId);
  if (duplicate) { $('#line-error').textContent = `L${number} existe déjà. Ouvrez cette ligne pour poursuivre ou terminer son OF.`; $('#line-error').hidden = false; return; }
  const line = { id: editingId || crypto.randomUUID(), lineNumber: number, length: Number(data.length), speed: Number(data.speed), coilsPerCycle: Number(data.coilsPerCycle), startAt: old?.startAt || null, production: old?.production || null, productionHistory: old?.productionHistory || [] };
  if (old?.production && !old.production.endAt) eventFor(line, 'correction-parametres', now(), { before: { lineNumber: old.lineNumber, length: old.length, speed: old.speed, coilsPerCycle: old.coilsPerCycle } });
  if (editingId) state.lines = state.lines.map((x) => x.id === editingId ? line : x); else state.lines.push(line);
  save(); $('#line-dialog').close(); render();
});
$('#delete-line').onclick = () => { state.lines = state.lines.filter((line) => line.id !== editingId); save(); $('#line-dialog').close(); render(); };

$('#line-list').addEventListener('click', (e) => {
  const card = e.target.closest('.line-card'); if (!card) return; const line = lineById(card.dataset.id);
  try {
    if (e.target.closest('.start-now-button')) start(line, now());
    else if (e.target.closest('.manual-start-button')) openEvent(line, 'startManual');
    else showDetails(line.id);
  } catch (error) { alert(error.message); }
});
$('#line-list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('line-card')) { e.preventDefault(); showDetails(e.target.dataset.id); } });

$('#close-event').onclick = $('#cancel-event').onclick = () => $('#event-dialog').close();
$('#event-form').addEventListener('submit', (e) => {
  e.preventDefault(); const { line, type } = pendingEvent;
  try {
    const declaredAt = resolveManualTime(new FormData(e.currentTarget).get('time'), currentWindow(), now()); const p = currentProduction(line);
    if (type === 'startManual') start(line, declaredAt);
    else if (type === 'correctStart') { p.startAt = declaredAt; line.startAt = declaredAt; eventFor(line, 'correction-depart', declaredAt); save(); render(); }
    else if (type === 'pause') { if (declaredAt < p.startAt) throw new Error('L’arrêt ne peut pas précéder le départ.'); p.pausedAt = declaredAt; p.pauses.push({ startAt: declaredAt, endAt: null, reason: new FormData(e.currentTarget).get('reason') || STOP_REASONS[0] }); eventFor(line, 'pause', declaredAt, { reason: p.pauses.at(-1).reason }); save(); render(); }
    else if (type === 'resume') { const pause = p.pauses.at(-1); if (!pause) throw new Error('Aucun arrêt en cours.'); if (declaredAt < pause.startAt) throw new Error('La reprise ne peut pas précéder le début de l’arrêt.'); pause.endAt = declaredAt; p.pausedAt = null; eventFor(line, 'reprise', declaredAt, { pauseDurationMs: declaredAt - pause.startAt, reason: pause.reason }); save(); render(); }
    else if (type === 'endOf') { if (declaredAt < p.startAt) throw new Error('La fin d’OF ne peut pas précéder le départ.'); p.endAt = declaredAt; eventFor(line, 'fin-of', declaredAt); save(); render(); }
    $('#event-dialog').close(); if (type !== 'startManual') showDetails(line.id);
  } catch (error) { $('#event-error').textContent = error.message; $('#event-error').hidden = false; }
});

$('#detail-dialog').addEventListener('click', (e) => {
  if (e.target.classList.contains('close-detail') || e.target === $('#detail-dialog')) return $('#detail-dialog').close();
  const action = e.target.closest('[data-action]')?.dataset.action; if (!action) return; const line = lineById($('#detail-dialog').dataset.lineId);
  $('#detail-dialog').close();
  if (action === 'edit') openForm(line);
  else if (action === 'correct') openEvent(line, 'correctStart');
  else if (action === 'pause') openEvent(line, 'pause');
  else if (action === 'resume') openEvent(line, 'resume');
  else if (action === 'endof') openEvent(line, 'endOf');
  else if (action === 'complete') { eventFor(line, 'cycle-termine', now()); save(); render(); showDetails(line.id); }
  else if (action === 'waste') openWaste(line);
  else if (action === 'newof') { try { start(line, now(), 'nouvel-of'); } catch (error) { alert(error.message); } }
});

$('#close-waste').onclick = () => $('#waste-dialog').close();
$('#waste-codes').addEventListener('click', (e) => { const b = e.target.closest('[data-code]'); if (b) selectWaste(b.dataset.code); });
$('#waste-back').onclick = () => { selectedWaste = null; $('#waste-step-codes').hidden = false; $('#waste-step-weight').hidden = true; };
$('.numeric-pad').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; const input = $('#waste-form').elements.weight;
  if (b.dataset.key === 'back') input.value = input.value.slice(0, -1); else { const key = b.textContent.trim(); if ((key === ',' || key === '.') && /[,.]/.test(input.value)) return; input.value += key; }
});
$('#waste-form').addEventListener('submit', (e) => {
  e.preventDefault(); if (!pendingWaste || !selectedWaste) return;
  const raw = e.currentTarget.elements.weight.value.trim().replace(',', '.'); const weight = Number(raw);
  if (!Number.isFinite(weight) || weight <= 0) { $('#waste-error').textContent = 'Saisissez un poids supérieur à 0 kg.'; $('#waste-error').hidden = false; return; }
  eventFor(pendingWaste, 'dechet', now(), { wasteCode: selectedWaste[0], wasteLabel: selectedWaste[1], weightKg: weight });
  save(); $('#waste-dialog').close(); render(); alert(`Déchet enregistré : ${selectedWaste[0]} — ${selectedWaste[1]} — ${String(weight).replace('.', ',')} kg`);
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#install-button').hidden = false; });
$('#install-button').onclick = async () => { await installPrompt?.prompt(); $('#install-button').hidden = true; };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
render(); setInterval(render, 10_000);