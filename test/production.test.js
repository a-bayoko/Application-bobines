import test from 'node:test';
import assert from 'node:assert/strict';
import { palletsCompleted, palletProgress, plannedCoils, completeCycle, undoCycle, shiftSummary, eventsToCsv, clippedPauseMs } from '../src/production.js';

const T = (s) => new Date(s).getTime();

test('T09 · palette MT12 : déclenchement à 12, 24, 36…', () => {
  assert.deepEqual(palletsCompleted(11, 12, 12), [{ number: 1, first: 1, last: 12 }]);
  assert.deepEqual(palletsCompleted(13, 14, 12), []);
  assert.deepEqual(palletsCompleted(23, 24, 12), [{ number: 2, first: 13, last: 24 }]);
  assert.deepEqual(palletsCompleted(349, 360, 12).at(-1), { number: 30, first: 349, last: 360 });
});

test('T11 · conditionnement inconnu : aucune palette inventée', () => {
  assert.deepEqual(palletsCompleted(1, 50, null), []);
  assert.equal(palletProgress(37, null), null);
  assert.equal(palletProgress(37, ''), null);
});

test('palette en cours et plage de bobines prévue', () => {
  assert.deepEqual(palletProgress(36, 12), { number: 4, count: 0, capacity: 12, first: 37 });
  assert.deepEqual(palletProgress(41, 12), { number: 4, count: 5, capacity: 12, first: 37 });
  assert.deepEqual(plannedCoils(36, 4, 2), { from: 37, to: 44 });
  assert.equal(plannedCoils(36, 0, 2), null);
});

test('T08 · continuité : la numérotation reprend à la bobine suivante sans doublon ni saut', () => {
  const production = { id: 'p1', startAt: T('2025-01-01T14:00'), lastCoil: 36, palletCapacity: 12, pallets: [] };
  const a = completeCycle(production, { coilsPerCycle: 2, at: T('2025-01-01T14:50'), operator: '1073', eventId: 'e1' });
  assert.deepEqual([a.from, a.to], [37, 38]);
  const b = completeCycle(production, { coilsPerCycle: 2, at: T('2025-01-01T15:40'), operator: '1073', eventId: 'e2' });
  assert.deepEqual([b.from, b.to], [39, 40]);
  assert.equal(production.lastCoil, 40);
  assert.equal(production.anchorAt, T('2025-01-01T15:40'));
});

test('validation d’un cycle qui complète une palette', () => {
  const production = { id: 'p1', startAt: T('2025-01-01T14:00'), lastCoil: 10, palletCapacity: 12, pallets: [] };
  const r = completeCycle(production, { coilsPerCycle: 2, at: T('2025-01-01T15:00'), operator: '1073', eventId: 'e1' });
  assert.equal(r.pallets.length, 1);
  assert.equal(production.pallets[0].number, 1);
  assert.equal(production.pallets[0].grossKg, null); // T10/T11 : poids saisi ensuite, net jamais inventé
  assert.equal(production.pallets[0].operator, '1073');
});

test('annulation du dernier cycle : numéro, ancrage et palette restaurés', () => {
  const production = { id: 'p1', startAt: T('2025-01-01T14:00'), lastCoil: 10, palletCapacity: 12, pallets: [] };
  const r = completeCycle(production, { coilsPerCycle: 2, at: T('2025-01-01T15:00'), operator: '1073', eventId: 'e1' });
  undoCycle(production, { id: 'e1', coilFrom: r.from, coilTo: r.to, prevAnchor: r.prevAnchor });
  assert.equal(production.lastCoil, 10);
  assert.equal(production.anchorAt, null);
  assert.deepEqual(production.pallets, []);
});

test('annulation refusée si ce n’est pas le dernier cycle', () => {
  const production = { id: 'p1', lastCoil: 12, pallets: [] };
  assert.throws(() => undoCycle(production, { id: 'x', coilFrom: 9, coilTo: 10 }));
});

test('durée d’arrêt limitée à la fenêtre du poste', () => {
  const pause = { startAt: T('2025-01-01T13:30'), endAt: T('2025-01-01T14:20') };
  assert.equal(clippedPauseMs(pause, T('2025-01-01T14:00'), T('2025-01-01T22:00'), T('2025-01-01T16:00')), 20 * 6e4);
  const open = { startAt: T('2025-01-01T15:00'), endAt: null };
  assert.equal(clippedPauseMs(open, T('2025-01-01T14:00'), T('2025-01-01T22:00'), T('2025-01-01T15:30')), 30 * 6e4);
});

test('T15 · bilan de poste cohérent avec les événements opérateur', () => {
  const window = { start: new Date('2025-01-01T14:00'), end: new Date('2025-01-01T22:00') };
  const line = {
    id: 'L4', lineNumber: 4,
    production: { id: 'p1', ofNumber: 'OF123', pauses: [{ startAt: T('2025-01-01T16:00'), endAt: T('2025-01-01T16:25'), reason: 'Réglage' }], pallets: [{ number: 1, closedAt: T('2025-01-01T17:00'), grossKg: null }] },
    productionHistory: []
  };
  const events = [
    { lineId: 'L4', type: 'cycle-termine', declaredAt: T('2025-01-01T14:50'), coilFrom: 1, coilTo: 2 },
    { lineId: 'L4', type: 'cycle-termine', declaredAt: T('2025-01-01T15:40'), coilFrom: 3, coilTo: 4 },
    { lineId: 'L4', type: 'cycle-termine', declaredAt: T('2025-01-01T16:40'), coilFrom: 5, coilTo: 6, cancelledAt: T('2025-01-01T16:41') },
    { lineId: 'L4', type: 'cycle-termine', declaredAt: T('2025-01-01T13:40'), coilFrom: 99, coilTo: 100 }, // poste précédent
    { lineId: 'L4', type: 'dechet', declaredAt: T('2025-01-01T15:00'), wasteCode: 'D1', weightKg: 2.5 },
    { lineId: 'L4', type: 'dechet', declaredAt: T('2025-01-01T18:00'), wasteCode: 'D1', weightKg: 1 },
    { lineId: 'L4', type: 'anomalie', declaredAt: T('2025-01-01T18:00'), category: 'Défaut produit' }
  ];
  const [row] = shiftSummary({ lines: [line], events, window, now: T('2025-01-01T20:00') });
  assert.equal(row.cycles, 2);
  assert.equal(row.coils, 4);
  assert.deepEqual([row.firstCoil, row.lastCoil], [1, 4]);
  assert.equal(row.stops, 1);
  assert.equal(row.stopMs, 25 * 6e4);
  assert.equal(row.wasteKg, 3.5);
  assert.equal(row.wasteByCode.D1, 3.5);
  assert.equal(row.pallets, 1);
  assert.equal(row.palletsMissingWeight, 1);
  assert.equal(row.anomalies, 1);
  assert.equal(row.ofNumber, 'OF123');
});

test('export CSV : en-tête, séparateur « ; », guillemets échappés', () => {
  const csv = eventsToCsv([
    { declaredAt: T('2025-01-01T15:00'), recordedAt: T('2025-01-01T15:01'), shiftId: 'afternoon', operatorNumber: '1073', lineNumber: 4, type: 'anomalie', category: 'Autre', note: 'dit "urgent"; voir chef' },
    { declaredAt: T('2025-01-01T14:50'), recordedAt: T('2025-01-01T14:50'), shiftId: 'afternoon', operatorNumber: '1073', lineNumber: 4, ofNumber: 'OF1', type: 'cycle-termine', coilFrom: 1, coilTo: 2 }
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0].split(';')[0], 'Date');
  assert.match(lines[1], /Cycle terminé;Bobines 1–2/); // trié par heure déclarée
  assert.match(lines[2], /"Autre · dit ""urgent""; voir chef"/);
});
