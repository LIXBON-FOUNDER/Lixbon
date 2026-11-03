/**
 * Agrupa los eventos de `activity.attempt.*` de UN Attempt en tramos de ejecución. La maqueta agrupa por «turno» (mensajes y
 * llamadas a herramientas del agente), pero el Core no guarda eso en Activity: solo el ciclo de vida del Attempt. Lo que sí se
 * puede decir sin inventar nada es cuándo empezó a ejecutarse, cuándo paró y por qué, y cuánto duró cada tramo.
 *
 * Un tramo empieza en `started` o `resumed` y acaba en el primer evento que lo para (espera, cierre, fallo o detención).
 * Antes del primer tramo van la solicitud y la aprobación; lo que llega después de que un tramo acabó (integración, cola)

 * va aparte, sin duración; si es un cierre (se detuvo, falló…) tras una espera, es el grupo «Cierre». La entrada llega del más nuevo al más viejo; la salida conserva ese orden (grupos e ítems).
 */
const RUN_START = new Set(['activity.attempt.started', 'activity.attempt.resumed']);
const RUN_END = new Set([
  'activity.attempt.waiting', 'activity.attempt.awaiting_terminal_approval', 'activity.attempt.completed',
  'activity.attempt.failed', 'activity.attempt.stopped', 'activity.attempt.exited',
]);

const FINAL = new Set(['activity.attempt.completed', 'activity.attempt.failed', 'activity.attempt.stopped', 'activity.attempt.exited']);

const bySequence = (a, b) => (Number(a.seq) - Number(b.seq)) || ((a.ts ?? 0) - (b.ts ?? 0));
const isTime = (value) => Number.isFinite(value) && value > 0;

/** @returns {Array<{id: string, kind: 'before'|'run'|'closing'|'after', n: number|null, open: boolean, startedAt: number|null, durationMs: number|null, endKey: string|null, items: object[]}>} */
export function groupAttemptActivity(items) {
  if (!Array.isArray(items)) return [];
  const chronological = [...items].sort(bySequence);
  const groups = [];
  let runs = 0;
  let current = null;
  const open = (kind, event) => {
    current = { id: `${kind}-${groups.length}`, kind, n: kind === 'run' ? (runs += 1) : null, open: kind === 'run', startedAt: kind === 'run' ? event.ts : null, durationMs: null, endKey: null, items: [] };
    groups.push(current);
  };
  for (const event of chronological) {
    if (RUN_START.has(event.message_key)) open('run', event);
    else if (!current) open('before', event);
    else if (current.kind === 'run' && !current.open) open(FINAL.has(event.message_key) ? 'closing' : 'after', event);
    current.items.push(event);
    if (current.kind === 'run' && current.open && RUN_END.has(event.message_key)) {
      current.open = false;
      current.endKey = event.message_key;
      current.durationMs = isTime(current.startedAt) && isTime(event.ts) && event.ts >= current.startedAt ? event.ts - current.startedAt : null;
    }
  }
  return groups.reverse().map((group) => ({ ...group, items: [...group.items].reverse() }));
}
