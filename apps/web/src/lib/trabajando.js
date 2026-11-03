// Conversaciones con una respuesta en curso. El chat las marca al enviar y las
// desmarca al terminar; la barra lateral pinta su título con el brillo de
// «Pensando», también si el usuario se fue a otro chat mientras tanto.
import { useSyncExternalStore } from 'react';

const enCurso = new Set();
const oyentes = new Set();
let version = 0;

export function marcarTrabajando(convId, activo) {
  if (!convId) return;
  const habia = enCurso.has(convId);
  if (activo === habia) return;
  if (activo) enCurso.add(convId); else enCurso.delete(convId);
  version += 1;
  oyentes.forEach((f) => f());
}

export const estaTrabajando = (convId) => enCurso.has(convId);

const suscribir = (f) => { oyentes.add(f); return () => oyentes.delete(f); };

/** Se vuelve a pintar cuando cambia el conjunto; devuelve la función de consulta. */
export function useTrabajando() {
  useSyncExternalStore(suscribir, () => version, () => 0);
  return estaTrabajando;
}
