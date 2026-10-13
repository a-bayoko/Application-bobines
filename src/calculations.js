// Moteur de calcul — Application Bobines.
// Règle de base : durée d'un cycle = métrage / vitesse du banc de tirage (m/min).
// La vitesse extrudeuse ne doit jamais être utilisée ici.

export const SHIFTS = [
  { id: 'morning', label: 'Matin', start: '06:00', end: '14:00' },
  { id: 'afternoon', label: 'Après-midi', start: '14:00', end: '22:00' },
  { id: 'night', label: 'Nuit', start: '22:00', end: '06:00' },
  { id: 'weekend-day', label: 'Week-end jour', start: '06:00', end: '18:00' },
  { id: 'weekend-night', label: 'Week-end nuit', start: '18:00', end: '06:00' }
];

// Seuils de marge de fin de poste (minutes). Valeurs actuelles conservées :
// rouge ≤ 20, orange ≤ 38, vert au-delà. Les cas 20 et 36–38 restent À CONFIRMER
// par le terrain : ne modifier ces valeurs qu'après validation.
export const CONFIG = {
  marginRedMaxMin: 20,
  marginOrangeMaxMin: 38
};

const MIN = 60_000;

/** Vrai si métrage et vitesse sont connus et exploitables. */
export function paramsKnown(line) {
  return Number(line?.length) > 0 && Number(line?.speed) > 0;
}

export function cycleDurationMs(length, speed, _coilsPerCycle) {
  if (!(Number(length) > 0) || !(Number(speed) > 0)) return NaN;
  return (Number(length) / Number(speed)) * MIN;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)} min ${String(totalSeconds % 60).padStart(2, '0')} s`;
}

export function formatMinutes(ms) {
  const minutes = Math.max(0, Math.round(ms / MIN));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

export function formatClock(value) {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function getShiftWindow(shiftId, now = new Date()) {
  const shift = SHIFTS.find((item) => item.id === shiftId) || SHIFTS[0];
  const [sh, sm] = shift.start.split(':').map(Number);
  const [eh, em] = shift.end.split(':').map(Number);
  const start = new Date(now); start.setHours(sh, sm, 0, 0);
  const end = new Date(now); end.setHours(eh, em, 0, 0);
  if (end <= start) {
    if (new Date(now) < end) start.setDate(start.getDate() - 1);
    else end.setDate(end.getDate() + 1);
  }
  return { ...shift, start, end };
}

/** Poste de semaine (matin / après-midi / nuit) qui contient l'instant donné. */
export function suggestedShiftId(now = new Date()) {
  const at = new Date(now).getTime();
  const found = ['morning', 'afternoon', 'night'].find((id) => {
    const w = getShiftWindow(id, now);
    return at >= w.start.getTime() && at < w.end.getTime();
  });
  return found || 'morning';
}

export function isWithinShift(shiftId, now = new Date()) {
  const w = getShiftWindow(shiftId, now);
  const at = new Date(now).getTime();
  return at >= w.start.getTime() && at < w.end.getTime();
}

export function getStatus(marginMs) {
  const minutes = marginMs / MIN;
  if (minutes <= CONFIG.marginRedMaxMin) return { label: 'ROUGE', className: 'red' };
  if (minutes <= CONFIG.marginOrangeMaxMin) return { label: 'ORANGE', className: 'orange' };
  return { label: 'VERT', className: 'green' };
}

/**
 * Point de départ du calcul des prochains cycles : la dernière fin de cycle
 * réellement validée, sinon l'heure de départ de l'OF.
 */
export function cycleAnchor(production) {
  if (!production) return null;
  return Number(production.anchorAt ?? production.startAt);
}

export function projectCycles({ startAt, durationMs, shiftEnd, pauses = [], stoppedAt = null }) {
  const cycles = [];
  const end = new Date(shiftEnd).getTime();
  const stop = stoppedAt ? Math.min(Number(stoppedAt), end) : end;
  const pausesBeforeEnd = pauses
    .filter((pause) => pause.startAt < stop && !(pause.endAt && pause.endAt <= Number(startAt)))
    .sort((a, b) => a.startAt - b.startAt);
  let cursor = Number(startAt);
  let pauseIndex = 0;
  if (!(durationMs > 0)) return { cycles: [], marginMs: null, status: null, nextImpossible: false };
  while (cursor < stop) {
    let remaining = durationMs;
    const cycleStart = cursor;
    while (remaining > 0) {
      const pause = pausesBeforeEnd[pauseIndex];
      if (!pause || pause.startAt >= cursor + remaining || pause.startAt >= stop) { cursor += remaining; remaining = 0; break; }
      if (pause.startAt > cursor) { remaining -= pause.startAt - cursor; cursor = pause.startAt; }
      if (!pause.endAt) { cursor = Infinity; break; }
      cursor = Math.max(cursor, pause.endAt);
      pauseIndex += 1;
    }
    if (!Number.isFinite(cursor) || cursor > stop) break;
    cycles.push({ start: cycleStart, end: cursor });
  }
  const last = cycles.at(-1);
  const marginMs = last ? end - last.end : null;
  const status = marginMs === null ? null : getStatus(marginMs);
  return {
    cycles: cycles.map((cycle, index) => ({ ...cycle, number: index + 1, highlighted: Boolean(status && index >= cycles.length - 3), status })),
    marginMs,
    status,
    nextImpossible: Boolean(!stoppedAt && cursor !== Infinity && cursor > end)
  };
}

export function activeCycle(production, durationMs, shiftEnd, at = Date.now()) {
  if (!production?.startAt || production.endAt || production.pausedAt || !(durationMs > 0)) return null;
  const end = new Date(shiftEnd).getTime();
  const time = Math.min(Number(at), end);
  const anchor = cycleAnchor(production);
  if (time >= end || time < anchor) return null;
  // Le cycle physique peut franchir la relève : on l'affiche, sans le compter dans la production terminée du poste.
  const projected = projectCycles({ startAt: anchor, durationMs, shiftEnd: end + durationMs + 24 * 60 * MIN, pauses: production.pauses || [] });
  const cycle = projected.cycles.find((item) => item.start < end && item.end > time);
  if (!cycle) return null;
  const elapsed = Math.max(0, time - cycle.start);
  const span = Math.max(1, cycle.end - cycle.start);
  return { ...cycle, progress: Math.min(100, Math.max(0, (elapsed / span) * 100)) };
}

export function nextCycleEnd(production, durationMs, shiftEnd = null, at = Date.now()) {
  if (!production?.startAt || production.endAt || production.pausedAt || !(durationMs > 0)) return null;
  const limit = shiftEnd ? new Date(shiftEnd).getTime() : at + 366 * 24 * 60 * MIN;
  if (at >= limit) return null;
  const projected = projectCycles({ startAt: cycleAnchor(production), durationMs, shiftEnd: limit, pauses: production.pauses || [] });
  return projected.cycles.find((cycle) => cycle.end > at)?.end || null;
}

/**
 * Prévision jusqu'à la relève, à partir de la dernière fin validée.
 * - pending : cycles théoriquement terminés pendant ce poste mais pas encore validés
 * - stalePending : cycles finis avant le début du poste et jamais validés (compteur à vérifier)
 * - remaining : cycles qui peuvent encore se terminer avant la relève
 * - lastEnd / marginMs / status : dernier cycle possible avant la relève et sa marge
 * - lastBeforeShift : le cycle en cours est le dernier qui finit avant la relève
 */
export function shiftForecast(production, durationMs, shiftEnd, at = Date.now(), shiftStart = null) {
  const empty = { pending: 0, stalePending: 0, remaining: 0, lastEnd: null, marginMs: null, status: null, lastBeforeShift: false };
  if (!production?.startAt || production.endAt || production.pausedAt || !(durationMs > 0)) return empty;
  const end = new Date(shiftEnd).getTime();
  if (at >= end) return empty;
  const p = projectCycles({ startAt: cycleAnchor(production), durationMs, shiftEnd: end, pauses: production.pauses || [] });
  // Cycles finis avant le début du poste = non validés par l'équipe précédente : on ne les fait pas
  // valider (et horodater) par l'équipe actuelle, on signale seulement que le compteur est à vérifier.
  const startLimit = shiftStart == null ? -Infinity : new Date(shiftStart).getTime();
  const pending = p.cycles.filter((c) => c.end <= at && c.end >= startLimit).length;
  const stalePending = p.cycles.filter((c) => c.end < startLimit).length;
  const future = p.cycles.filter((c) => c.end > at);
  return {
    pending,
    stalePending,
    remaining: future.length,
    lastEnd: future.at(-1)?.end ?? null,
    marginMs: future.length ? end - future.at(-1).end : null,
    status: future.length ? getStatus(end - future.at(-1).end) : null,
    lastBeforeShift: future.length === 1
  };
}

export function resolveManualTime(time, shiftWindow, now = Date.now()) {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('Saisissez une heure au format HH:MM.');
  const [hours, minutes] = time.split(':').map(Number);
  if (hours > 23 || minutes > 59) throw new Error('L’heure saisie est invalide.');
  const candidates = [-1, 0, 1].map((offset) => {
    const date = new Date(shiftWindow.start);
    date.setDate(date.getDate() + offset);
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  });
  const latest = Math.min(Number(now), shiftWindow.end.getTime());
  const result = candidates.find((value) => value >= shiftWindow.start.getTime() && value <= latest);
  if (!result) throw new Error('Cette heure doit appartenir au poste actif et ne peut pas être dans le futur.');
  return result;
}
