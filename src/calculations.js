export const SHIFTS = [
  { id: 'morning', label: 'Matin', start: '06:00', end: '14:00' },
  { id: 'afternoon', label: 'Après-midi', start: '14:00', end: '22:00' },
  { id: 'night', label: 'Nuit', start: '22:00', end: '06:00' },
  { id: 'weekend-day', label: 'Week-end jour', start: '06:00', end: '18:00' },
  { id: 'weekend-night', label: 'Week-end nuit', start: '18:00', end: '06:00' }
];

export function cycleDurationMs(length, speed, _coilsPerCycle) { return (Number(length) / Number(speed)) * 60_000; }
export function formatDuration(ms) { const totalSeconds = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(totalSeconds / 60)} min ${String(totalSeconds % 60).padStart(2, '0')} s`; }
export function formatClock(value) { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
export function getShiftWindow(shiftId, now = new Date()) {
  const shift = SHIFTS.find((item) => item.id === shiftId) || SHIFTS[0];
  const [sh, sm] = shift.start.split(':').map(Number); const [eh, em] = shift.end.split(':').map(Number);
  const start = new Date(now); start.setHours(sh, sm, 0, 0); const end = new Date(now); end.setHours(eh, em, 0, 0);
  if (end <= start) { if (now < end) start.setDate(start.getDate() - 1); else end.setDate(end.getDate() + 1); }
  return { ...shift, start, end };
}
export function getStatus(marginMs) { const minutes = marginMs / 60_000; if (minutes <= 20) return { label: 'ROUGE', className: 'red' }; if (minutes <= 38) return { label: 'ORANGE', className: 'orange' }; return { label: 'VERT', className: 'green' }; }
export function projectCycles({ startAt, durationMs, shiftEnd, pauses = [], stoppedAt = null }) {
  const cycles = []; const end = new Date(shiftEnd).getTime(); const pausesBeforeEnd = pauses.filter((pause) => pause.startAt < end).sort((a, b) => a.startAt - b.startAt);
  let cursor = Number(startAt); let pauseIndex = 0;
  while (cursor < end && (!stoppedAt || cursor < stoppedAt)) {
    let remaining = durationMs; const cycleStart = cursor;
    while (remaining > 0) {
      const pause = pausesBeforeEnd[pauseIndex];
      const boundary = stoppedAt ? Math.min(end, stoppedAt) : end;
      if (!pause || pause.startAt >= cursor + remaining || pause.startAt >= boundary) { cursor += remaining; remaining = 0; break; }
      if (pause.startAt > cursor) { remaining -= pause.startAt - cursor; cursor = pause.startAt; }
      if (!pause.endAt) { cursor = Infinity; break; }
      cursor = Math.max(cursor, pause.endAt); pauseIndex += 1;
    }
    if (!Number.isFinite(cursor) || cursor > end || (stoppedAt && cursor > stoppedAt)) break;
    cycles.push({ start: cycleStart, end: cursor });
  }
  const last = cycles.at(-1); const marginMs = last ? end - last.end : null; const status = marginMs === null ? null : getStatus(marginMs);
  return { cycles: cycles.map((cycle, index) => ({ ...cycle, number: index + 1, highlighted: Boolean(status && index >= cycles.length - 3), status })), marginMs, status, nextImpossible: Boolean(!stoppedAt && cursor !== Infinity && cursor > end) };
}
export function nextCycleEnd(production, durationMs, now = Date.now()) {
  if (!production?.startAt || production.endAt || production.pausedAt) return null;
  const projected = projectCycles({ startAt: production.startAt, durationMs, shiftEnd: new Date(now + 366 * 24 * 60 * 60_000), pauses: production.pauses || [] });
  return projected.cycles.find((cycle) => cycle.end > now)?.end || null;
}
export function resolveManualTime(time, shiftWindow, now = Date.now()) {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('Saisissez une heure au format HH:MM.');
  const [hours, minutes] = time.split(':').map(Number); if (hours > 23 || minutes > 59) throw new Error('L’heure saisie est invalide.');
  const candidates = [-1, 0, 1].map((offset) => { const date = new Date(shiftWindow.start); date.setDate(date.getDate() + offset); date.setHours(hours, minutes, 0, 0); return date.getTime(); });
  const latest = Math.min(Number(now), shiftWindow.end.getTime()); const result = candidates.find((value) => value >= shiftWindow.start.getTime() && value <= latest);
  if (!result) throw new Error('Cette heure doit appartenir au poste actif et ne peut pas être dans le futur.');
  return result;
}
