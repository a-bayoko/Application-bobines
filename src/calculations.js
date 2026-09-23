export const SHIFTS = [
  { id: 'morning', label: 'Matin', start: '06:00', end: '14:00' },
  { id: 'afternoon', label: 'Après-midi', start: '14:00', end: '22:00' },
  { id: 'night', label: 'Nuit', start: '22:00', end: '06:00' },
  { id: 'weekend-day', label: 'Week-end jour', start: '06:00', end: '18:00' },
  { id: 'weekend-night', label: 'Week-end nuit', start: '18:00', end: '06:00' }
];

export function cycleDurationMs(length, speed) { return (Number(length) / Number(speed)) * 60_000; }
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)} min ${String(totalSeconds % 60).padStart(2, '0')} s`;
}
export function formatClock(value) { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
export function getShiftWindow(shiftId, now = new Date()) {
  const shift = SHIFTS.find((item) => item.id === shiftId) || SHIFTS[0];
  const [sh, sm] = shift.start.split(':').map(Number); const [eh, em] = shift.end.split(':').map(Number);
  const start = new Date(now); start.setHours(sh, sm, 0, 0);
  const end = new Date(now); end.setHours(eh, em, 0, 0);
  if (end <= start) {
    if (now < end) start.setDate(start.getDate() - 1);
    else end.setDate(end.getDate() + 1);
  }
  return { ...shift, start, end };
}
export function getStatus(marginMs) {
  const minutes = marginMs / 60_000;
  if (minutes <= 20) return { label: 'ROUGE', className: 'red' };
  if (minutes <= 38) return { label: 'ORANGE', className: 'orange' };
  return { label: 'VERT', className: 'green' };
}
export function projectCycles({ startAt, durationMs, shiftEnd }) {
  const cycles = []; let cursor = new Date(startAt).getTime(); const end = new Date(shiftEnd).getTime();
  while (cursor < end) { const next = cursor + durationMs; cycles.push({ start: cursor, end: next, exceedsShift: next > end }); if (next > end) break; cursor = next; }
  const completed = cycles.filter((cycle) => !cycle.exceedsShift);
  const last = completed.at(-1);
  const marginMs = last ? end - last.end : null;
  const status = marginMs === null ? null : getStatus(marginMs);
  return { cycles: cycles.map((cycle, index) => ({ ...cycle, number: index + 1, highlighted: Boolean(status && index >= completed.length - 3 && !cycle.exceedsShift), status })), marginMs, status };
}
export function nextCycleEnd(line, now = Date.now()) {
  if (!line.startAt) return null; const duration = cycleDurationMs(line.length, line.speed); const elapsed = Math.max(0, now - line.startAt); return line.startAt + (Math.floor(elapsed / duration) + 1) * duration;
}
