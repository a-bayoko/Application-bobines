import {
  SHIFTS, cycleDurationMs, formatDuration, formatMinutes, formatClock, getShiftWindow, projectCycles,
  activeCycle, shiftForecast, resolveManualTime, paramsKnown, suggestedShiftId, isWithinShift, cycleAnchor
} from './calculations.js';
import { completeCycle, undoCycle, palletProgress, plannedCoils, shiftSummary, eventsToCsv } from './production.js';

export const APP_VERSION = '2.1.1';
const KEY = 'application-bobines-v1'; // clé conservée : les données déjà enregistrées sur l'appareil restent valables

const LINE_GROUPS = {
  A1: [4, 5, 14, 1],
  A2: [8, 3, 6, 7],
  B1: [13, 9, 12, 15],
  B2: [10, 16, 17, 18]
};
// Seuls paramètres confirmés (dossier de passation, références observées). Les autres lignes restent « à renseigner ».
const DEFAULT_LINE_PARAMS = {
  1: { length: 5700, speed: 60, coilsPerCycle: 2 },
  4: { length: 3200, speed: 60, coilsPerCycle: 2 },
  5: { length: 1800, speed: 41, coilsPerCycle: 2 },
  14: { length: 3000, speed: 80, coilsPerCycle: 2 }
};
const STOP_REASONS = ['Panne machine', 'Réglage', 'Changement matière', 'Contrôle qualité', 'Manque matière', 'Autre'];
const WASTE_CODES = [
  ['D1', 'Zip ouvert'], ['D2', 'Défaut d’enroulement'], ['D3', 'Zip cassé'], ['D4', 'Défaut dimensionnel'],
  ['D5', 'Présence de particule'], ['D6', 'Force d’ouverture'], ['D7', 'Autre (CS, etc.)'], ['D8', 'Nettoyage filière'],
  ['DC', 'Coupe du voile'], ['RR', 'Déchet de réglage']
];
const ANOMALY_CATEGORIES = ['Défaut produit', 'Bobine à déclasser', 'Contrôle qualité hors cible', 'Machine / process', 'Manutention', 'Autre'];
const DOUBLE_TAP_MS = 60_000;

const $ = (s) => document.querySelector(s);
const now = () => Date.now();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kg = (n) => `${String(Math.round(n * 100) / 100).replace('.', ',')} kg`;

// ---------- État et migration ----------
function migrateLine(line) {
  const out = {
    ...line,
    productionHistory: Array.isArray(line.productionHistory) ? line.productionHistory : [],
    production: line.production || (line.startAt ? { id: uid(), startAt: line.startAt, pauses: [], endAt: null } : null)
  };
  // Correctif : les versions précédentes attribuaient 3000 m / 60 m/min aux lignes inconnues (valeurs inventées).
  const n = Number(out.lineNumber);
  const untouched = !out.production && out.productionHistory.length === 0 && !out.paramsConfirmed;
  if (!DEFAULT_LINE_PARAMS[n] && untouched && Number(out.length) === 3000 && Number(out.speed) === 60) {
    out.length = null; out.speed = null;
  }
  if (out.production) {
    out.production.pauses = out.production.pauses || [];
    out.production.lastCoil = Number(out.production.lastCoil) || 0;
    out.production.pallets = out.production.pallets || [];
  }
  return out;
}

function migrate(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  return {
    shiftId: base.shiftId || suggestedShiftId(),
    operatorSessions: base.operatorSessions && typeof base.operatorSessions === 'object' ? base.operatorSessions : {},
    lineGroup: base.lineGroup && LINE_GROUPS[base.lineGroup] ? base.lineGroup : 'A1',
    events: Array.isArray(base.events) ? base.events : [],
    lines: Array.isArray(base.lines) ? base.lines.map(migrateLine) : []
  };
}

function loadState() {
  try { return migrate(JSON.parse(localStorage.getItem(KEY) || 'null')); }
  catch { loadState.readError = true; return migrate(null); }
}

let state = loadState();
const existingNumbers = new Set(state.lines.map((line) => Number(line.lineNumber)));
Object.values(LINE_GROUPS).flat().forEach((lineNumber) => {
  if (existingNumbers.has(lineNumber)) return;
  const p = DEFAULT_LINE_PARAMS[lineNumber] || { length: null, speed: null, coilsPerCycle: 2 };
  state.lines.push({ id: uid(), lineNumber, ...p, startAt: null, production: null, productionHistory: [] });
});

function save() {
  if (loadState.readError) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { toast('⚠ Enregistrement impossible sur cet appareil (mémoire pleine ou navigation privée).', true); }
}
save();

// Synchronisation entre onglets ouverts sur le même appareil (évite deux états divergents).
window.addEventListener('storage', (e) => { if (e.key === KEY) { state = loadState(); render(); } });

let editingId = null;
let installPrompt;
let pendingEvent = null;
let pendingWaste = null;
let selectedWaste = null;
let pendingAnomaly = null;
let pendingPallets = [];
const notifiedCycleEnds = new Set();

const lineById = (id) => state.lines.find((line) => line.id === id);
const currentWindow = () => getShiftWindow(state.shiftId);
function shiftSessionKey() { return `${state.shiftId}:${currentWindow().start.toISOString()}`; }
function operatorNumber() { return String(state.operatorSessions[shiftSessionKey()] || ''); }
function currentProduction(line) { return line.production || null; }
function durationOf(line) { return cycleDurationMs(line.length, line.speed); }

function requireOperator() {
  if (operatorNumber()) return true;
  toast('Saisissez d’abord votre n° opérateur.', true);
  const input = $('#operator-number');
  input.classList.add('attention');
  input.focus();
  setTimeout(() => input.classList.remove('attention'), 2500);
  return false;
}

function eventFor(line, type, declaredAt, extra = {}) {
  const event = {
    id: uid(), recordedAt: now(), declaredAt, type, lineId: line.id, lineNumber: line.lineNumber,
    operatorNumber: operatorNumber(), shiftId: state.shiftId, shiftStart: currentWindow().start.getTime(),
    productionId: line.production?.id || null, ofNumber: line.production?.ofNumber || '',
    production: { length: line.length, speed: line.speed, coilsPerCycle: line.coilsPerCycle },
    ...extra
  };
  state.events.push(event);
  return event;
}

function toast(message, warning = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('warning', warning);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function alertCycleEnd(line) {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* non supporté */ }
  toast(`L${line.lineNumber} : cycle terminé — à valider`);
}

// ---------- Rendu du tableau de bord ----------
function renderShiftWarning(window) {
  const box = $('#shift-warning');
  if (isWithinShift(state.shiftId)) { box.hidden = true; return; }
  const suggestion = SHIFTS.find((s) => s.id === suggestedShiftId());
  const status = now() < window.start.getTime() ? 'n’a pas encore commencé' : 'est terminé';
  box.innerHTML = `⚠ Le poste sélectionné ${status}. <button type="button" data-shift="${suggestion.id}" class="link-button">Passer au poste ${esc(suggestion.label)} (${suggestion.start} → ${suggestion.end})</button>`;
  box.hidden = false;
}

function cardMeta(line, production, forecast) {
  const parts = [];
  if (production?.ofNumber) parts.push(`<span>OF ${esc(production.ofNumber)}</span>`);
  if (production) {
    const target = production.target ? ` / ${production.target}` : '';
    parts.push(`<span>Bob. <b>${production.lastCoil || 0}</b>${target}</span>`);
    const pal = palletProgress(production.lastCoil, production.palletCapacity);
    if (pal) parts.push(`<span>Pal. ${pal.number} : <b>${pal.count}/${pal.capacity}</b></span>`);
    const missing = (production.pallets || []).filter((p) => p.grossKg == null).length;
    if (missing) parts.push(`<span class="chip orange">⚖ ${missing} poids à saisir</span>`);
  }
  if (forecast?.stalePending) parts.push(`<span class="chip orange">⚠ Compteur non validé depuis ${formatClock(cycleAnchor(production))} : vérifiez la dernière bobine</span>`);
  if (forecast?.pending) parts.push(`<span class="chip blink">▲ ${forecast.pending} cycle${forecast.pending > 1 ? 's' : ''} à valider</span>`);
  if (forecast?.lastEnd) {
    parts.push(`<span class="chip ${forecast.status.className}">Dernier cycle du poste ${formatClock(forecast.lastEnd)} · marge ${formatMinutes(forecast.marginMs)}</span>`);
  } else if (forecast && production && !production.endAt && !production.pausedAt) {
    parts.push('<span class="chip red">Plus aucun cycle ne finit avant la relève</span>');
  }
  return parts.join('');
}

function render() {
  const window = currentWindow();
  const currentTime = now();
  $('#app-version').textContent = `v${APP_VERSION}`;
  $('#shift-range').textContent = `${formatClock(window.start)} → ${formatClock(window.end)}`;
  const opInput = $('#operator-number');
  if (document.activeElement !== opInput) opInput.value = operatorNumber(); // ne jamais écraser une saisie en cours
  $('#shift-options').innerHTML = SHIFTS.map((shift) => `<button class="shift-option ${shift.id === state.shiftId ? 'selected' : ''}" data-shift="${shift.id}" role="radio" aria-checked="${shift.id === state.shiftId}">${shift.label}<small>${shift.start} → ${shift.end}</small></button>`).join('');
  renderShiftWarning(window);
  $('#line-groups').innerHTML = Object.entries(LINE_GROUPS).map(([group, lines]) => `<button class="group-option ${group === state.lineGroup ? 'selected' : ''}" data-group="${group}"><strong>${group}</strong><small>L${lines.join(' · L')}</small></button>`).join('');

  const order = LINE_GROUPS[state.lineGroup];
  const visibleLines = state.lines
    .filter((line) => order.includes(Number(line.lineNumber)))
    .sort((a, b) => order.indexOf(Number(a.lineNumber)) - order.indexOf(Number(b.lineNumber)));
  const list = $('#line-list');
  list.innerHTML = '';
  $('#empty-state').hidden = visibleLines.length > 0;
  $('.dashboard-columns').hidden = visibleLines.length === 0;
  $('#dashboard-help').textContent = `${state.lineGroup} · ${visibleLines.length} lignes attribuées · touchez une ligne pour les actions.`;

  visibleLines.forEach((line) => {
    const card = $('#line-card-template').content.firstElementChild.cloneNode(true);
    const known = paramsKnown(line);
    const duration = durationOf(line);
    const production = currentProduction(line);
    const endedByShift = Boolean(production && currentTime >= window.end.getTime());
    const paused = Boolean(production && !production.endAt && production.pausedAt);
    const running = production && !production.endAt && !endedByShift;
    const cycle = running && known ? activeCycle(production, duration, window.end, currentTime) : null;
    const forecast = running && known && !paused ? shiftForecast(production, duration, window.end, currentTime, window.start) : null;

    card.dataset.id = line.id;
    card.querySelector('.line-name').textContent = `L${line.lineNumber}`;
    card.querySelector('.line-config').textContent = known ? `${line.length} m · ${line.speed} m/min` : 'Paramètres à renseigner';
    const stateLabel = card.querySelector('.line-state');
    if (!known && !production) stateLabel.textContent = 'À configurer';
    else if (!production) stateLabel.textContent = 'À démarrer';
    else if (production.endAt) stateLabel.textContent = 'OF terminé';
    else if (endedByShift) stateLabel.textContent = 'Poste terminé';
    else if (paused) stateLabel.textContent = 'En arrêt';
    else if (forecast?.pending) stateLabel.textContent = 'Cycle à valider';
    else if (forecast?.lastBeforeShift) stateLabel.textContent = 'Passation proche';
    else stateLabel.textContent = 'En production';

    if (paused) card.classList.add('is-paused');
    if (forecast?.pending) {
      card.classList.add('needs-validation');
      const key = `${line.id}:${cycleAnchor(production)}`;
      if (!notifiedCycleEnds.has(key)) { notifiedCycleEnds.add(key); if (render.ready) alertCycleEnd(line); }
    }

    if (forecast?.pending) {
      const pendingEnd = projectCycles({ startAt: cycleAnchor(production), durationMs: duration, shiftEnd: window.end, pauses: production.pauses || [] }).cycles.find((c) => c.end >= window.start.getTime())?.end;
      card.querySelector('.cycle-window').textContent = pendingEnd ? `Fini à ${formatClock(pendingEnd)}` : 'Fin de cycle atteinte';
      card.querySelector('.progress-fill').style.width = '100%';
      card.querySelector('.progress-value').textContent = '100%';
    } else if (cycle) {
      card.querySelector('.cycle-window').textContent = `${formatClock(cycle.start)} → ${formatClock(cycle.end)}`;
      card.querySelector('.progress-fill').style.width = `${cycle.progress.toFixed(1)}%`;
      card.querySelector('.progress-value').textContent = `${Math.round(cycle.progress)}%`;
    } else if (paused) {
      card.querySelector('.cycle-window').textContent = `Arrêt depuis ${formatClock(production.pausedAt)}`;
      card.querySelector('.progress-value').textContent = 'ARRÊT';
    } else if (endedByShift && !production.endAt) {
      card.querySelector('.cycle-window').textContent = `Relève ${formatClock(window.end)}`;
      card.querySelector('.progress-value').textContent = 'FIN';
    } else if (production?.endAt) {
      card.querySelector('.cycle-window').textContent = `OF fini ${formatClock(production.endAt)}`;
      card.querySelector('.progress-value').textContent = 'OF';
    }

    const meta = card.querySelector('.card-meta');
    const metaHtml = cardMeta(line, production, forecast);
    meta.innerHTML = metaHtml;
    meta.hidden = !metaHtml;
    card.querySelector('.quick-start').hidden = Boolean(production) || !known;
    card.querySelector('.quick-config').hidden = known || Boolean(production);
    list.append(card);
  });
  render.ready = true;
}

// ---------- Formulaire ligne / OF ----------
function openForm(line = null, { newOf = false } = {}) {
  editingId = line?.id || null;
  const f = $('#line-form');
  f.reset();
  $('#line-error').hidden = true;
  const production = line?.production && !line.production.endAt ? line.production : null;
  $('#dialog-title').textContent = line ? (newOf ? `Nouvel OF sur L${line.lineNumber}` : `Modifier L${line.lineNumber}`) : 'Configurer une ligne';
  $('#form-kicker').textContent = newOf ? 'NOUVEL OF' : line ? 'PARAMÈTRES LIGNE ET OF' : 'NOUVELLE LIGNE';
  $('#delete-line').hidden = !line || newOf;
  if (line) {
    ['lineNumber', 'length', 'speed', 'coilsPerCycle'].forEach((k) => { if (line[k] != null) field(f, k).value = line[k]; });
    const of = production || (newOf ? {} : line.pendingOf || {});
    f.elements.ofNumber.value = of.ofNumber || '';
    f.elements.target.value = of.target || '';
    f.elements.palletCapacity.value = of.palletCapacity || '';
    f.elements.lastCoil.value = production ? production.lastCoil || 0 : of.lastCoil || 0;
  }
  $('#last-coil-label').firstChild.textContent = production ? 'Dernière bobine validée (correction)' : 'Dernière bobine déjà réalisée sur cet OF';
  $('#last-coil-help').textContent = production
    ? 'À modifier uniquement pour corriger un écart. La correction est tracée dans l’historique.'
    : '0 pour un nouvel OF. Si l’équipe précédente a déjà produit, indiquez sa dernière bobine : vous reprendrez à la suivante.';
  updatePreview();
  $('#line-dialog').showModal();
}

function updatePreview() {
  const f = $('#line-form');
  const d = cycleDurationMs(field(f, 'length').value, field(f, 'speed').value);
  $('#duration-preview').textContent = d > 0 ? `Durée calculée : ${formatDuration(d)}` : 'La durée du cycle apparaîtra ici.';
}

// form.elements.length renvoie le NOMBRE de champs, pas le champ « length » (métrage) :
// cause du plantage de « ⚙ CORRIGER » dans la v2.0.0. On passe toujours par namedItem.
function field(form, name) { return form.elements.namedItem(name); }

const optionalNumber = (v) => (v === '' || v == null || !(Number(v) > 0) ? null : Number(v));

function submitLineForm(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.currentTarget));
  const old = editingId && lineById(editingId);
  const number = Number(data.lineNumber);
  const duplicate = state.lines.find((x) => Number(x.lineNumber) === number && x.id !== editingId);
  if (duplicate) {
    $('#line-error').textContent = `L${number} existe déjà. Ouvrez cette ligne pour poursuivre ou terminer son OF.`;
    $('#line-error').hidden = false;
    return;
  }
  const lastCoil = Math.max(0, Math.floor(Number(data.lastCoil) || 0));
  const ofData = { ofNumber: String(data.ofNumber || '').trim(), target: optionalNumber(data.target), palletCapacity: optionalNumber(data.palletCapacity), lastCoil };
  const line = {
    ...(old || {}),
    id: editingId || uid(), lineNumber: number, length: Number(data.length), speed: Number(data.speed),
    coilsPerCycle: Number(data.coilsPerCycle), paramsConfirmed: true,
    startAt: old?.startAt || null, production: old?.production || null, productionHistory: old?.productionHistory || []
  };
  const active = line.production && !line.production.endAt ? line.production : null;
  if (active) {
    const changed = ['lineNumber', 'length', 'speed', 'coilsPerCycle'].some((k) => Number(old[k]) !== Number(line[k]));
    if (changed) eventFor(line, 'correction-parametres', now(), { before: { lineNumber: old.lineNumber, length: old.length, speed: old.speed, coilsPerCycle: old.coilsPerCycle } });
    if (lastCoil !== Number(active.lastCoil || 0)) {
      if (!requireOperator()) return;
      eventFor(line, 'correction-bobine', now(), { before: active.lastCoil || 0, after: lastCoil });
      active.lastCoil = lastCoil;
    }
    active.ofNumber = ofData.ofNumber;
    active.target = ofData.target;
    active.palletCapacity = ofData.palletCapacity;
  } else {
    line.pendingOf = ofData; // appliqué au démarrage
  }
  if (editingId) state.lines = state.lines.map((x) => (x.id === editingId ? line : x));
  else state.lines.push(line);
  save();
  $('#line-dialog').close();
  render();
}

// ---------- Actions de production ----------
function start(line, declaredAt, type = 'start') {
  if (!requireOperator()) return false;
  if (!paramsKnown(line)) { openForm(line); return false; }
  const window = currentWindow();
  if (declaredAt < window.start.getTime() || declaredAt > window.end.getTime()) throw new Error('Le départ doit appartenir au poste actif.');
  if (line.production && !line.production.endAt) throw new Error('Un OF est déjà en cours sur cette ligne.');
  if (line.production?.endAt) line.productionHistory = [...(line.productionHistory || []), line.production];
  const of = line.pendingOf || {};
  line.production = {
    id: uid(), startAt: declaredAt, pauses: [], endAt: null,
    ofNumber: of.ofNumber || '', target: of.target ?? null, palletCapacity: of.palletCapacity ?? null,
    lastCoil: Number(of.lastCoil) || 0, pallets: [], startedBy: operatorNumber(), startedShift: state.shiftId
  };
  line.pendingOf = null;
  line.startAt = declaredAt;
  eventFor(line, type, declaredAt, { lastCoilAtStart: line.production.lastCoil });
  save();
  render();
  return true;
}

function validateCycle(line) {
  if (!requireOperator()) return;
  const p = line.production;
  if (!p || p.endAt) return;
  if (p.pausedAt) { toast('Ligne en arrêt : déclarez la reprise avant de valider un cycle.', true); return; }
  const at = now();
  if (p.lastCompletionAt && at - p.lastCompletionAt < DOUBLE_TAP_MS) {
    const seconds = Math.round((at - p.lastCompletionAt) / 1000);
    if (!confirm(`Un cycle a déjà été validé il y a ${seconds} s sur L${line.lineNumber}. Valider quand même un nouveau cycle ?`)) return;
  }
  const eventId = uid();
  const result = completeCycle(p, { coilsPerCycle: line.coilsPerCycle, at, operator: operatorNumber(), eventId });
  // le même identifiant relie l'événement et les palettes clôturées (utile pour l'annulation)
  const ev = eventFor(line, 'cycle-termine', at, { id: eventId, coilFrom: result.from, coilTo: result.to, prevAnchor: result.prevAnchor });
  result.pallets.forEach((pal) => eventFor(line, 'palette-complete', at, { palletNumber: pal.number, first: pal.first, last: pal.last, sourceEventId: ev.id }));
  save();
  render();
  toast(`L${line.lineNumber} : bobines ${result.from}–${result.to} validées`);
  if (result.pallets.length) {
    try { navigator.vibrate?.([300, 100, 300]); } catch { /* non supporté */ }
    pendingPallets = result.pallets.map((pal) => ({ lineId: line.id, palletNumber: pal.number }));
    openNextPallet();
  } else {
    showDetails(line.id);
  }
}

function undoLastCycle(line) {
  const p = line.production;
  const last = [...state.events].reverse().find((e) => e.lineId === line.id && e.productionId === p.id && e.type === 'cycle-termine' && !e.cancelledAt);
  if (!last) { toast('Aucun cycle validé à annuler.', true); return; }
  if (!confirm(`Annuler la validation des bobines ${last.coilFrom}–${last.coilTo} sur L${line.lineNumber} ?`)) return;
  try {
    undoCycle(p, last);
    last.cancelledAt = now();
    state.events.filter((e) => e.sourceEventId === last.id).forEach((e) => { e.cancelledAt = now(); });
    eventFor(line, 'annulation-cycle', now(), { coilFrom: last.coilFrom, coilTo: last.coilTo, cancelledEventId: last.id });
    save();
    render();
    showDetails(line.id);
  } catch (error) { toast(error.message, true); }
}

// ---------- Palettes ----------
function openNextPallet() {
  const next = pendingPallets.shift();
  if (!next) return;
  const line = lineById(next.lineId);
  const pal = line?.production?.pallets.find((p) => p.number === next.palletNumber);
  if (!pal) return openNextPallet();
  const form = $('#pallet-form');
  form.reset();
  form.dataset.lineId = line.id;
  form.dataset.pallet = pal.number;
  $('#pallet-error').hidden = true;
  $('#pallet-kicker').textContent = `L${line.lineNumber} · OPÉRATEUR ${operatorNumber()}`;
  $('#pallet-title').textContent = `PALETTE ${pal.number} COMPLÈTE`;
  $('#pallet-info').innerHTML = [
    line.production.ofNumber ? `OF <b>${esc(line.production.ofNumber)}</b>` : 'OF non renseigné',
    `Bobines <b>${pal.first} → ${pal.last}</b> (${pal.last - pal.first + 1})`,
    `Clôturée à ${formatClock(pal.closedAt)} par ${esc(pal.operator)}`
  ].join(' · ');
  if (pal.grossKg != null) form.elements.weight.value = String(pal.grossKg).replace('.', ',');
  $('#pallet-dialog').showModal();
}

function submitPallet(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const line = lineById(form.dataset.lineId);
  const pal = line?.production?.pallets.find((p) => p.number === Number(form.dataset.pallet));
  if (!pal) return $('#pallet-dialog').close();
  const weight = Number(form.elements.weight.value.trim().replace(',', '.'));
  if (!Number.isFinite(weight) || weight <= 0) {
    $('#pallet-error').textContent = 'Saisissez le poids brut mesuré (supérieur à 0 kg).';
    $('#pallet-error').hidden = false;
    return;
  }
  const before = pal.grossKg;
  pal.grossKg = weight;
  pal.weighedAt = now();
  pal.weighedBy = operatorNumber();
  eventFor(line, 'poids-palette', now(), { palletNumber: pal.number, grossKg: weight, before });
  save();
  $('#pallet-dialog').close();
  render();
  toast(`Palette ${pal.number} : ${kg(weight)} brut enregistrés`);
  if (pendingPallets.length) openNextPallet(); else showDetails(line.id);
}

// ---------- Détail d'une ligne ----------
function showDetails(id) {
  const line = lineById(id);
  const production = currentProduction(line);
  if (!production || !paramsKnown(line)) return openForm(line);
  const window = currentWindow();
  const currentTime = now();
  const duration = durationOf(line);
  const anchor = cycleAnchor(production);
  const p = projectCycles({ startAt: anchor, durationMs: duration, shiftEnd: window.end, pauses: production.pauses || [], stoppedAt: production.endAt });
  const ended = currentTime >= window.end.getTime();
  const paused = Boolean(!production.endAt && production.pausedAt);
  const active = !production.endAt && !ended;
  const n = Number(line.coilsPerCycle) || 1;
  const lastCoil = production.lastCoil || 0;
  const futureCycles = p.cycles.filter((c) => c.end > currentTime);
  const planned = plannedCoils(lastCoil, futureCycles.length, n);
  const pal = palletProgress(lastCoil, production.palletCapacity);
  const missingWeights = (production.pallets || []).filter((x) => x.grossKg == null);
  const lastCycleEvent = [...state.events].reverse().find((e) => e.productionId === production.id && e.type === 'cycle-termine' && !e.cancelledAt);

  const facts = [
    ['OF', production.ofNumber ? esc(production.ofNumber) : '<i>non renseigné</i>'],
    ['Dernière bobine validée', lastCoil ? `n° <b>${lastCoil}</b>${lastCycleEvent ? ` à ${formatClock(lastCycleEvent.declaredAt)} (op. ${esc(lastCycleEvent.operatorNumber)})` : ''}` : 'aucune'],
    ['Objectif', production.target ? `${lastCoil} / ${production.target}${lastCoil >= production.target ? ` <b class="text-orange">· atteint${lastCoil > production.target ? ` (+${lastCoil - production.target})` : ''}</b>` : ` · reste ${production.target - lastCoil}`}` : '<i>non renseigné</i>'],
    ['Palette en cours', pal ? `n° ${pal.number} : ${pal.count}/${pal.capacity} (bobines ${pal.first}–${pal.first + pal.capacity - 1})` : '<i>conditionnement non renseigné</i>'],
    ['Bobines prévues avant relève', planned ? `${planned.from} → ${planned.to} (${futureCycles.length} cycle${futureCycles.length > 1 ? 's' : ''})` : 'aucune'],
    ['Lancé par', `${esc(production.startedBy || '—')} à ${formatClock(production.startAt)}`]
  ];

  const nextFrom = lastCoil + 1;
  const actions = active ? `
    <button data-action="complete" class="complete-button big-button" ${paused ? 'disabled' : ''}>✓ CYCLE TERMINÉ<small>bobines ${nextFrom}–${nextFrom + n - 1}</small></button>
    <div class="detail-actions">
      ${paused ? '<button data-action="resume" class="resume-button">▶ REPRISE</button>' : '<button data-action="pause" class="pause-button">⏸ ARRÊT / PAUSE</button>'}
      <button data-action="waste" class="waste-button">⚖ DÉCLARER DÉCHET</button>
      <button data-action="anomaly" class="secondary-button">⚠ ANOMALIE</button>
      <button data-action="undo" class="secondary-button" ${lastCycleEvent ? '' : 'disabled'}>↶ ANNULER DERNIER CYCLE</button>
      <button data-action="edit" class="secondary-button">⚙ CORRIGER / OF</button>
      <button data-action="correct" class="secondary-button">🕒 CORRIGER DÉPART</button>
      <button data-action="endof" class="end-of-button">■ FIN D’OF</button>
    </div>` : `<div class="detail-actions">
      <button data-action="edit" class="secondary-button">⚙ CORRIGER</button>
      ${production.endAt ? '<button data-action="newof" class="primary-button">▶ NOUVEL OF</button>' : ''}
    </div>`;

  $('#detail-content').innerHTML = `
    <div class="dialog-header"><div><p class="eyebrow">${paused ? 'LIGNE EN ARRÊT' : production.endAt ? 'OF TERMINÉ' : 'LIGNE EN COURS'}</p><h2>L${line.lineNumber}</h2></div><button class="close-button close-detail" aria-label="Fermer">×</button></div>
    <p class="detail-intro">${line.length} m · ${line.speed} m/min · ${n} bobine(s)/cycle · durée ${formatDuration(duration)}</p>
    ${ended && !production.endAt ? `<p class="shift-ended">Poste terminé à ${formatClock(window.end)}. Aucun cycle finissant après la relève n’est compté pour cet opérateur. L’équipe suivante reprend à la bobine ${nextFrom}.</p>` : ''}
    ${missingWeights.length ? `<div class="pending-weights">${missingWeights.map((x) => `<button data-action="weigh" data-pallet="${x.number}" class="pause-button">⚖ Saisir le poids de la palette ${x.number}</button>`).join('')}</div>` : ''}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${actions}
    <details class="projection-details"><summary>Voir la projection détaillée (${p.cycles.length} cycles jusqu’à la relève)</summary>
      <ol class="cycle-list">${p.cycles.map((c, i) => {
        const done = c.end <= currentTime;
        const from = lastCoil + i * n + 1;
        return `<li class="${c.highlighted ? `highlight ${c.status.className}` : ''}"><b>Cycle ${c.number}</b><span>${formatClock(c.start)} → ${formatClock(c.end)}</span><em>bob. ${from}–${from + n - 1}${done ? ' · à valider' : ''}</em></li>`;
      }).join('') || '<li>Aucun cycle ne peut se terminer avant la relève.</li>'}</ol>
    </details>`;
  $('#detail-dialog').dataset.lineId = id;
  $('#detail-dialog').showModal();
}

// ---------- Saisie d'heure (départ, arrêt, reprise, fin d'OF) ----------
function openEvent(line, type) {
  if (!requireOperator()) return;
  pendingEvent = { line, type };
  const form = $('#event-form');
  form.reset();
  $('#event-error').hidden = true;
  const labels = { startManual: 'Saisir l’heure de départ', correctStart: 'Corriger l’heure de départ', pause: 'Arrêt / pause', resume: 'Reprise', endOf: 'Fin d’OF' };
  $('#event-title').textContent = labels[type];
  $('#event-kicker').textContent = `L${line.lineNumber} · OPÉRATEUR ${operatorNumber()}`;
  $('#reason-label').hidden = type !== 'pause';
  form.elements.reason.innerHTML = STOP_REASONS.map((r) => `<option>${r}</option>`).join('');
  $('#event-time-label').firstChild.textContent = type === 'correctStart' ? 'Nouvelle heure de départ' : 'Heure déclarée';
  form.elements.time.value = new Date().toTimeString().slice(0, 5);
  $('#event-dialog').showModal();
}

function submitEvent(e) {
  e.preventDefault();
  const { line, type } = pendingEvent;
  const formData = new FormData(e.currentTarget);
  try {
    const declaredAt = resolveManualTime(formData.get('time'), currentWindow(), now());
    const p = currentProduction(line);
    if (type === 'startManual') {
      if (!start(line, declaredAt)) return;
    } else if (type === 'correctStart') {
      if (p.lastCompletionAt && declaredAt > p.lastCompletionAt) throw new Error('Le départ ne peut pas être postérieur au dernier cycle validé.');
      const before = p.startAt;
      p.startAt = declaredAt;
      line.startAt = declaredAt;
      eventFor(line, 'correction-depart', declaredAt, { before });
    } else if (type === 'pause') {
      if (declaredAt < p.startAt) throw new Error('L’arrêt ne peut pas précéder le départ.');
      if (p.pausedAt) throw new Error('Un arrêt est déjà en cours.');
      const reason = formData.get('reason') || STOP_REASONS[0];
      p.pausedAt = declaredAt;
      p.pauses.push({ startAt: declaredAt, endAt: null, reason, operator: operatorNumber() });
      eventFor(line, 'pause', declaredAt, { reason });
    } else if (type === 'resume') {
      const pause = p.pauses.at(-1);
      if (!pause || pause.endAt) throw new Error('Aucun arrêt en cours.');
      if (declaredAt < pause.startAt) throw new Error('La reprise ne peut pas précéder le début de l’arrêt.');
      pause.endAt = declaredAt;
      p.pausedAt = null;
      eventFor(line, 'reprise', declaredAt, { pauseDurationMs: declaredAt - pause.startAt, reason: pause.reason });
    } else if (type === 'endOf') {
      if (declaredAt < p.startAt) throw new Error('La fin d’OF ne peut pas précéder le départ.');
      if (p.pausedAt) { const pause = p.pauses.at(-1); if (pause && !pause.endAt) pause.endAt = Math.max(declaredAt, pause.startAt); p.pausedAt = null; }
      p.endAt = declaredAt;
      p.endedBy = operatorNumber();
      eventFor(line, 'fin-of', declaredAt, { lastCoil: p.lastCoil || 0, target: p.target ?? null });
    }
    save();
    render();
    $('#event-dialog').close();
    if (type !== 'startManual') showDetails(line.id);
  } catch (error) {
    $('#event-error').textContent = error.message;
    $('#event-error').hidden = false;
  }
}

// ---------- Déchets ----------
function openWaste(line) {
  if (!requireOperator()) return;
  pendingWaste = line;
  selectedWaste = null;
  $('#waste-kicker').textContent = `L${line.lineNumber} · OPÉRATEUR ${operatorNumber()}`;
  $('#waste-step-codes').hidden = false;
  $('#waste-step-weight').hidden = true;
  $('#waste-error').hidden = true;
  $('#waste-form').elements.weight.value = '';
  $('#waste-codes').innerHTML = WASTE_CODES.map(([code, label]) => `<button type="button" class="waste-code" data-code="${code}"><strong>${code}</strong><span>${label}</span></button>`).join('');
  $('#waste-dialog').showModal();
}

function selectWaste(code) {
  selectedWaste = WASTE_CODES.find(([item]) => item === code);
  if (!selectedWaste) return;
  $('#waste-selected').innerHTML = `<strong>${selectedWaste[0]}</strong> — ${selectedWaste[1]}`;
  $('#waste-step-codes').hidden = true;
  $('#waste-step-weight').hidden = false;
}

function submitWaste(e) {
  e.preventDefault();
  if (!pendingWaste || !selectedWaste) return;
  const weight = Number(e.currentTarget.elements.weight.value.trim().replace(',', '.'));
  if (!Number.isFinite(weight) || weight <= 0) {
    $('#waste-error').textContent = 'Saisissez un poids supérieur à 0 kg.';
    $('#waste-error').hidden = false;
    return;
  }
  eventFor(pendingWaste, 'dechet', now(), { wasteCode: selectedWaste[0], wasteLabel: selectedWaste[1], weightKg: weight });
  save();
  $('#waste-dialog').close();
  render();
  toast(`Déchet enregistré : ${selectedWaste[0]} — ${selectedWaste[1]} — ${kg(weight)}`);
}

// ---------- Anomalies ----------
function openAnomaly(line) {
  if (!requireOperator()) return;
  pendingAnomaly = { line, category: null };
  const form = $('#anomaly-form');
  form.reset();
  $('#anomaly-error').hidden = true;
  $('#anomaly-kicker').textContent = `L${line.lineNumber} · OPÉRATEUR ${operatorNumber()}`;
  $('#anomaly-codes').innerHTML = ANOMALY_CATEGORIES.map((c) => `<button type="button" class="waste-code" data-category="${esc(c)}"><span>${esc(c)}</span></button>`).join('');
  $('#anomaly-dialog').showModal();
}

function submitAnomaly(e) {
  e.preventDefault();
  if (!pendingAnomaly?.category) {
    $('#anomaly-error').textContent = 'Choisissez le type d’anomalie.';
    $('#anomaly-error').hidden = false;
    return;
  }
  const note = String(new FormData(e.currentTarget).get('note') || '').trim();
  eventFor(pendingAnomaly.line, 'anomalie', now(), { category: pendingAnomaly.category, note });
  save();
  $('#anomaly-dialog').close();
  render();
  toast(`Anomalie enregistrée sur L${pendingAnomaly.line.lineNumber}`);
}

// ---------- Bilan du poste ----------
function showSummary() {
  const window = currentWindow();
  const order = LINE_GROUPS[state.lineGroup];
  const groupLines = state.lines.filter((l) => order.includes(Number(l.lineNumber))).sort((a, b) => order.indexOf(Number(a.lineNumber)) - order.indexOf(Number(b.lineNumber)));
  const rows = shiftSummary({ lines: groupLines, events: state.events, window, now: now() });
  const totals = rows.reduce((t, r) => ({ coils: t.coils + r.coils, stopMs: t.stopMs + r.stopMs, wasteKg: t.wasteKg + r.wasteKg, pallets: t.pallets + r.pallets }), { coils: 0, stopMs: 0, wasteKg: 0, pallets: 0 });
  const handover = groupLines.map((line) => {
    const p = line.production;
    if (!p) return `<li><b>L${line.lineNumber}</b> · aucun OF</li>`;
    if (p.endAt) return `<li><b>L${line.lineNumber}</b> · OF ${esc(p.ofNumber || '—')} terminé à ${formatClock(p.endAt)} · dernière bobine ${p.lastCoil || 0}</li>`;
    const pal = palletProgress(p.lastCoil, p.palletCapacity);
    return `<li><b>L${line.lineNumber}</b> · OF ${esc(p.ofNumber || '—')} · dernière bobine <b>${p.lastCoil || 0}</b> · prochaine <b>${(p.lastCoil || 0) + 1}</b>${pal ? ` · palette ${pal.number} : ${pal.count}/${pal.capacity}` : ''}${p.pausedAt ? ` · <span class="text-orange">EN ARRÊT depuis ${formatClock(p.pausedAt)}</span>` : ''}</li>`;
  }).join('');
  $('#summary-content').innerHTML = `
    <div class="dialog-header"><div><p class="eyebrow">BILAN · ${state.lineGroup} · OPÉRATEUR ${esc(operatorNumber() || '—')}</p><h2>${esc(window.label)} · ${window.start.toLocaleDateString('fr-FR')} · ${formatClock(window.start)} → ${formatClock(window.end)}</h2></div><button class="close-button close-summary" aria-label="Fermer">×</button></div>
    <div class="kpis">
      <div><b>${totals.coils}</b><small>bobines validées</small></div>
      <div><b>${formatMinutes(totals.stopMs)}</b><small>d’arrêt</small></div>
      <div><b>${kg(totals.wasteKg)}</b><small>de déchets</small></div>
      <div><b>${totals.pallets}</b><small>palettes</small></div>
    </div>
    <div class="table-wrap"><table class="summary-table">
      <thead><tr><th>Ligne</th><th>Bobines</th><th>Arrêts</th><th>Déchets</th><th>Palettes</th><th>Anom.</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><b>L${r.lineNumber}</b>${r.ofNumber ? `<small>OF ${esc(r.ofNumber)}</small>` : ''}</td>
        <td>${r.coils}${r.firstCoil ? `<small>${r.firstCoil}→${r.lastCoil}</small>` : ''}</td>
        <td>${r.stops ? `${r.stops} · ${formatMinutes(r.stopMs)}<small>${esc([...new Set(r.stopReasons)].join(', '))}</small>` : '—'}</td>
        <td>${r.wasteKg ? `${kg(r.wasteKg)}<small>${Object.entries(r.wasteByCode).map(([c, w]) => `${c} ${kg(w)}`).join(' · ')}</small>` : '—'}</td>
        <td>${r.pallets || '—'}${r.palletsMissingWeight ? `<small class="text-orange">${r.palletsMissingWeight} sans poids</small>` : ''}</td>
        <td>${r.anomalies || '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    <h3>Passation à l’équipe suivante</h3>
    <ul class="handover">${handover}</ul>
    <div class="detail-actions">
      <button data-export="shift" class="secondary-button">⬇ Export CSV du poste</button>
      <button data-export="all" class="secondary-button">⬇ Export CSV complet</button>
    </div>
    <p class="field-help">Le fichier CSV s’ouvre dans Excel (séparateur « ; »).</p>`;
  $('#summary-dialog').showModal();
}

function downloadCsv(scope) {
  const window = currentWindow();
  const events = scope === 'shift'
    ? state.events.filter((e) => e.declaredAt >= window.start.getTime() && e.declaredAt < window.end.getTime())
    : state.events;
  if (!events.length) { toast('Aucun événement à exporter.', true); return; }
  const blob = new Blob([`﻿${eventsToCsv(events)}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const day = window.start.toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = scope === 'shift' ? `bobines_${day}_${state.shiftId}.csv` : `bobines_historique_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Clavier numérique partagé (déchet, palette) ----------
const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];
document.querySelectorAll('.numeric-pad').forEach((pad) => {
  pad.innerHTML = PAD_KEYS.map((k) => `<button type="button"${k === '⌫' ? ' data-key="back"' : ''}>${k}</button>`).join('');
  pad.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const input = pad.closest('form').elements.weight;
    if (b.dataset.key === 'back') input.value = input.value.slice(0, -1);
    else {
      const key = b.textContent.trim();
      if ((key === ',' || key === '.') && /[,.]/.test(input.value)) return;
      input.value += key;
    }
  });
});

// ---------- Écouteurs ----------
$('#operator-number').addEventListener('change', (e) => {
  const value = e.target.value.trim();
  const key = shiftSessionKey();
  if (value) state.operatorSessions[key] = value;
  else delete state.operatorSessions[key];
  save();
  render();
});
$('#operator-number').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

function selectShift(e) {
  const b = e.target.closest('[data-shift]');
  if (!b) return;
  state.shiftId = b.dataset.shift;
  save();
  render();
}
$('#shift-options').addEventListener('click', selectShift);
$('#shift-warning').addEventListener('click', selectShift);
$('#line-groups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (b) { state.lineGroup = b.dataset.group; save(); render(); }
});
$('#add-line').onclick = () => openForm();
$('.add-line-action').onclick = () => openForm();
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $('#line-dialog').close();
$('#line-form').addEventListener('input', updatePreview);
$('#line-form').addEventListener('submit', submitLineForm);
$('#capacity-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cap]');
  if (b) $('#line-form').elements.palletCapacity.value = b.dataset.cap;
});
$('#delete-line').onclick = () => {
  const line = lineById(editingId);
  if (line?.production && !line.production.endAt) {
    $('#line-error').textContent = 'Un OF est en cours sur cette ligne : terminez l’OF avant de supprimer la ligne.';
    $('#line-error').hidden = false;
    return;
  }
  if (!confirm(`Supprimer L${line?.lineNumber} de cet appareil ? L’historique des événements est conservé.`)) return;
  state.lines = state.lines.filter((l) => l.id !== editingId);
  save();
  $('#line-dialog').close();
  render();
};

$('#line-list').addEventListener('click', (e) => {
  const card = e.target.closest('.line-card');
  if (!card) return;
  const line = lineById(card.dataset.id);
  try {
    if (e.target.closest('.start-now-button')) start(line, now());
    else if (e.target.closest('.manual-start-button')) openEvent(line, 'startManual');
    else if (e.target.closest('.config-button')) openForm(line);
    else showDetails(line.id);
  } catch (error) { toast(error.message, true); }
});
$('#line-list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('line-card')) { e.preventDefault(); showDetails(e.target.dataset.id); }
});

$('#close-event').onclick = $('#cancel-event').onclick = () => $('#event-dialog').close();
$('#event-form').addEventListener('submit', submitEvent);

$('#detail-dialog').addEventListener('click', (e) => {
  if (e.target.classList.contains('close-detail') || e.target === $('#detail-dialog')) return $('#detail-dialog').close();
  const button = e.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const line = lineById($('#detail-dialog').dataset.lineId);
  $('#detail-dialog').close();
  if (action === 'edit') openForm(line);
  else if (action === 'correct') openEvent(line, 'correctStart');
  else if (action === 'pause') openEvent(line, 'pause');
  else if (action === 'resume') openEvent(line, 'resume');
  else if (action === 'endof') openEvent(line, 'endOf');
  else if (action === 'complete') validateCycle(line);
  else if (action === 'undo') undoLastCycle(line);
  else if (action === 'waste') openWaste(line);
  else if (action === 'anomaly') openAnomaly(line);
  else if (action === 'weigh') { pendingPallets = [{ lineId: line.id, palletNumber: Number(button.dataset.pallet) }]; openNextPallet(); }
  else if (action === 'newof') {
    if (!requireOperator()) return;
    line.productionHistory = [...(line.productionHistory || []), line.production];
    line.production = null;
    line.pendingOf = null;
    save();
    render();
    openForm(line, { newOf: true });
  }
});

$('#close-waste').onclick = () => $('#waste-dialog').close();
$('#waste-codes').addEventListener('click', (e) => { const b = e.target.closest('[data-code]'); if (b) selectWaste(b.dataset.code); });
$('#waste-back').onclick = () => { selectedWaste = null; $('#waste-step-codes').hidden = false; $('#waste-step-weight').hidden = true; };
$('#waste-form').addEventListener('submit', submitWaste);

$('#close-anomaly').onclick = () => $('#anomaly-dialog').close();
$('#anomaly-codes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-category]');
  if (!b) return;
  pendingAnomaly.category = b.dataset.category;
  document.querySelectorAll('#anomaly-codes .waste-code').forEach((x) => x.classList.toggle('selected', x === b));
});
$('#anomaly-form').addEventListener('submit', submitAnomaly);

$('#close-pallet').onclick = $('#pallet-later').onclick = () => {
  $('#pallet-dialog').close();
  pendingPallets = [];
  toast('Poids à saisir plus tard : rappel affiché sur la ligne.');
};
$('#pallet-form').addEventListener('submit', submitPallet);

$('#summary-button').onclick = showSummary;
$('#summary-dialog').addEventListener('click', (e) => {
  if (e.target.classList.contains('close-summary') || e.target === $('#summary-dialog')) return $('#summary-dialog').close();
  const b = e.target.closest('[data-export]');
  if (b) downloadCsv(b.dataset.export);
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#install-button').hidden = false; });
$('#install-button').onclick = async () => { await installPrompt?.prompt(); $('#install-button').hidden = true; };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');

if (loadState.readError) {
  document.body.replaceChildren();
  const notice = document.createElement('section');
  notice.style.cssText = 'padding:24px;max-width:650px;margin:auto';
  const title = document.createElement('h1');
  title.textContent = 'Données locales illisibles — saisie bloquée';
  const message = document.createElement('p');
  message.textContent = 'Les données originales sont conservées. Ne videz pas le stockage du navigateur. Téléchargez la sauvegarde pour demander une récupération.';
  const backup = document.createElement('button');
  backup.textContent = 'Télécharger les données originales';
  backup.onclick = () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw == null) throw new Error('Données indisponibles');
      const url = URL.createObjectURL(new Blob([raw], {type:'application/json'}));
      const a = document.createElement('a'); a.href = url; a.download = 'bobines-donnees-a-recuperer.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { message.textContent = 'Stockage inaccessible : ne réinitialisez pas le navigateur et contactez le support.'; }
  };
  notice.append(title, message, backup); document.body.append(notice);
} else {
  render();
  setInterval(render, 10_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}
