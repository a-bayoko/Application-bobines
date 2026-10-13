// Logique bobines / palettes / bilan de poste — fonctions pures, testées dans test/production.test.js.
// Aucune donnée métier n'est inventée : si la capacité palette ou l'objectif sont inconnus,
// les fonctions renvoient null et l'interface affiche « non renseigné ».

/** Palettes complétées par la validation des bobines from → to (capacité inconnue → aucune). */
export function palletsCompleted(from, to, capacity) {
  const cap = Number(capacity);
  if (!(cap > 0) || !(to >= from)) return [];
  const result = [];
  for (let m = Math.ceil(from / cap) * cap; m <= to; m += cap) {
    result.push({ number: m / cap, first: m - cap + 1, last: m });
  }
  return result;
}

/** Palette en cours après la bobine lastCoil. */
export function palletProgress(lastCoil, capacity) {
  const cap = Number(capacity);
  if (!(cap > 0)) return null;
  const done = Math.max(0, Number(lastCoil) || 0);
  return { number: Math.floor(done / cap) + 1, count: done % cap, capacity: cap, first: Math.floor(done / cap) * cap + 1 };
}

/** Plage de bobines prévue pour un nombre de cycles. */
export function plannedCoils(lastCoil, cycles, coilsPerCycle) {
  const n = Number(coilsPerCycle) || 1;
  if (!(cycles > 0)) return null;
  return { from: lastCoil + 1, to: lastCoil + cycles * n };
}

/**
 * Valide un cycle terminé : numérote les bobines, recale la projection sur l'heure réelle,
 * clôture les palettes complètes. Modifie `production` et renvoie ce qui a été fait.
 */
export function completeCycle(production, { coilsPerCycle, at, operator, eventId }) {
  const n = Math.max(1, Number(coilsPerCycle) || 1);
  const from = (Number(production.lastCoil) || 0) + 1;
  const to = from + n - 1;
  const prevAnchor = production.anchorAt ?? null;
  production.lastCoil = to;
  production.anchorAt = at;
  production.lastCompletionAt = at;
  const pallets = palletsCompleted(from, to, production.palletCapacity).map((p) => ({
    ...p, id: `${production.id}:P${p.number}`, closedAt: at, operator, grossKg: null, eventId
  }));
  production.pallets = [...(production.pallets || []).filter((p) => !pallets.some((x) => x.number === p.number)), ...pallets];
  return { from, to, prevAnchor, pallets };
}

/** Annule la validation d'un cycle (dernière en date uniquement). */
export function undoCycle(production, event) {
  if (Number(production.lastCoil) !== Number(event.coilTo)) {
    throw new Error('Seul le dernier cycle validé peut être annulé.');
  }
  production.lastCoil = Number(event.coilFrom) - 1;
  production.anchorAt = event.prevAnchor ?? null;
  production.lastCompletionAt = event.prevAnchor ?? null;
  production.pallets = (production.pallets || []).filter((p) => p.eventId !== event.id);
}

/** Durée d'arrêt d'une pause, limitée à la fenêtre [start, end]. */
export function clippedPauseMs(pause, start, end, now) {
  const s = Math.max(pause.startAt, start);
  const e = Math.min(pause.endAt ?? now, end, now);
  return Math.max(0, e - s);
}

/** Bilan du poste par ligne, à partir des événements et des productions. */
export function shiftSummary({ lines, events, window, now = Date.now() }) {
  const start = new Date(window.start).getTime();
  const end = new Date(window.end).getTime();
  const inWindow = (t) => t >= start && t < end;
  return lines.map((line) => {
    const lineEvents = events.filter((e) => e.lineId === line.id && !e.cancelledAt && inWindow(e.declaredAt));
    const cycles = lineEvents.filter((e) => e.type === 'cycle-termine');
    const coils = cycles.reduce((sum, e) => sum + (Number(e.coilTo) - Number(e.coilFrom) + 1 || 0), 0);
    const productions = [...(line.productionHistory || []), line.production].filter(Boolean);
    const stops = productions.flatMap((p) => (p.pauses || [])
      .map((pause) => ({ ...pause, ms: clippedPauseMs(pause, start, end, now) }))
      .filter((pause) => pause.ms > 0 || (pause.startAt >= start && pause.startAt < end)));
    const wastes = lineEvents.filter((e) => e.type === 'dechet');
    const wasteByCode = {};
    wastes.forEach((w) => { wasteByCode[w.wasteCode] = (wasteByCode[w.wasteCode] || 0) + Number(w.weightKg || 0); });
    const pallets = productions.flatMap((p) => (p.pallets || []).filter((pal) => inWindow(pal.closedAt)));
    const anomalies = lineEvents.filter((e) => e.type === 'anomalie');
    return {
      lineId: line.id,
      lineNumber: line.lineNumber,
      ofNumber: line.production?.ofNumber || '',
      cycles: cycles.length,
      coils,
      firstCoil: cycles.length ? Math.min(...cycles.map((e) => Number(e.coilFrom))) : null,
      lastCoil: cycles.length ? Math.max(...cycles.map((e) => Number(e.coilTo))) : null,
      stops: stops.length,
      stopMs: stops.reduce((sum, s) => sum + s.ms, 0),
      stopReasons: stops.map((s) => s.reason).filter(Boolean),
      wasteKg: wastes.reduce((sum, w) => sum + Number(w.weightKg || 0), 0),
      wasteByCode,
      pallets: pallets.length,
      palletsMissingWeight: pallets.filter((p) => p.grossKg == null).length,
      anomalies: anomalies.length
    };
  });
}

const EVENT_LABELS = {
  start: 'Démarrage',
  'nouvel-of': 'Nouvel OF',
  'cycle-termine': 'Cycle terminé',
  'annulation-cycle': 'Annulation cycle',
  pause: 'Arrêt / pause',
  reprise: 'Reprise',
  'fin-of': 'Fin d’OF',
  dechet: 'Déchet',
  anomalie: 'Anomalie',
  'palette-complete': 'Palette complète',
  'poids-palette': 'Poids palette',
  'correction-depart': 'Correction départ',
  'correction-parametres': 'Correction paramètres',
  'correction-bobine': 'Correction n° bobine'
};

export function eventLabel(type) { return EVENT_LABELS[type] || type; }

function csvCell(value) {
  const raw = value == null ? '' : String(value);
  const text = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function eventDetail(e) {
  switch (e.type) {
    case 'cycle-termine': return `Bobines ${e.coilFrom}–${e.coilTo}`;
    case 'annulation-cycle': return `Bobines ${e.coilFrom}–${e.coilTo} annulées`;
    case 'pause': return e.reason || '';
    case 'reprise': return `${e.reason || ''} · ${Math.round((e.pauseDurationMs || 0) / 60000)} min`;
    case 'dechet': return `${e.wasteCode} ${e.wasteLabel} · ${String(e.weightKg).replace('.', ',')} kg`;
    case 'anomalie': return `${e.category || ''}${e.note ? ` · ${e.note}` : ''}`;
    case 'palette-complete': return `Palette ${e.palletNumber} (bobines ${e.first}–${e.last})`;
    case 'poids-palette': return `Palette ${e.palletNumber} · brut ${String(e.grossKg).replace('.', ',')} kg`;
    case 'correction-bobine': return `Dernière bobine ${e.before} → ${e.after}`;
    case 'correction-depart': return e.before ? `Ancien départ ${new Date(e.before).toLocaleString('fr-FR')}` : '';
    default: return '';
  }
}

/** Export CSV (séparateur « ; » pour Excel français). */
export function eventsToCsv(events) {
  const header = ['Date', 'Heure déclarée', 'Heure de saisie', 'Poste', 'Opérateur', 'Ligne', 'OF', 'Événement', 'Détail', 'Annulé'];
  const rows = [...events]
    .sort((a, b) => a.declaredAt - b.declaredAt)
    .map((e) => {
      const d = new Date(e.declaredAt);
      return [
        d.toLocaleDateString('fr-FR'),
        d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        new Date(e.recordedAt).toLocaleString('fr-FR'),
        e.shiftId,
        e.operatorNumber,
        `L${e.lineNumber}`,
        e.ofNumber || '',
        eventLabel(e.type),
        eventDetail(e),
        e.cancelledAt ? 'oui' : ''
      ].map(csvCell).join(';');
    });
  return [header.join(';'), ...rows].join('\n');
}
