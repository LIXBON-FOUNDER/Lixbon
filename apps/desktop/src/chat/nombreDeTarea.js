const MAX = 48;

function turnoActual(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  return { pedido: messages[i] || null, turno: messages.slice(i + 1) };
}

function ultimoPasoCompletado(turno) {
  for (let i = turno.length - 1; i >= 0; i--) {
    const todos = turno[i].ccName === 'TodoWrite' ? turno[i].ccInput?.todos : null;
    if (!Array.isArray(todos)) continue;
    const hechos = todos.filter((t) => t?.status === 'completed' && t.content);
    if (hechos.length) return hechos[hechos.length - 1].content;
  }
  return '';
}

export function recortar(texto, max = MAX) {
  if (texto.length <= max) return texto;
  const corte = texto.slice(0, max + 1);
  const espacio = corte.lastIndexOf(' ');
  const base = espacio > max / 2 ? corte.slice(0, espacio) : texto.slice(0, max);
  return `${base.replace(/[\s.,;:¿?¡!-]+$/, '')}…`;
}

export function resumenDePedido(contenido) {
  const limpio = String(contenido || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)@\S+/g, ' ')
    .replace(/(^|\s)\/[\w:-]+(?=\s|$)/g, ' ');
  const linea = limpio.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  const frase = linea.match(/^.*?[.!?](?=\s|$)/)?.[0] || linea;
  return frase.replace(/[.\s]+$/, '');
}

function mayuscula(t) {
  return t.charAt(0).toLocaleUpperCase('es') + t.slice(1);
}

export function nombreDeTarea(s) {
  const messages = s.messages || [];
  const { pedido, turno } = turnoActual(messages);
  const nombre = ultimoPasoCompletado(turno).trim().replace(/\s+/g, ' ')
    || resumenDePedido(pedido?.content);
  if (nombre) return mayuscula(recortar(nombre));
  return s.conversationTitle || 'la tarea';
}
