// estadoAgente.js — lo que la mascota necesita saber del agente, leído de los
// mensajes de la sesión (sirve igual para el agente de Lixbon y Claude Code):
// si piensa o escribe, cuántos pasos lleva en este turno y qué propone hacer
// después cuando termina.
import { describeTool } from '../lib/toolText';

/** Mensajes del turno en curso: desde el último mensaje del usuario. */
function turno(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  return messages.slice(i + 1);
}

const ESCRIBE = /write|edit|append|insert|create|patch/i;

/** Estado del turno para animar a la mascota. */
export function actividadDe(s) {
  const t = turno(s.messages || []);
  const herramientas = t.filter((m) => m.role === 'tool');
  const ultimo = t[t.length - 1];
  const ultimaHerramienta = herramientas[herramientas.length - 1];
  return {
    trabajando: !!s.streaming,
    esperando: !!s.pendingApproval || !!s.pendingQuestion,
    escribiendo: (ultimo?.role === 'assistant' && !!(ultimo.content || '').trim())
      || (ultimo?.role === 'tool' && ESCRIBE.test(ultimo.tool || '')),
    pasos: herramientas.length,
    accion: ultimaHerramienta ? describeTool(ultimaHerramienta) : '',
  };
}

/** Con «Según la tarea»: teclea mientras responde o escribe archivos, va en
    kart mientras recorre el proyecto en varios pasos y piensa si aún no ha
    hecho nada. */
export function animacionDeTrabajo(prefs, act) {
  if (prefs.trabajo === 'conducir') return 'kart';
  if (act.escribiendo) return 'type';
  if (prefs.trabajo === 'escribir') return 'think';
  return act.pasos >= 2 ? 'kart' : 'think';
}

const NUM = /\bfase\s+(\d{1,2})\b/gi;

function ultimaFase(textos) {
  let n = 0;
  for (const t of textos) {
    for (const m of String(t || '').matchAll(NUM)) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/** La pregunta que hace la mascota cuando el agente termina, con respuestas
    que se mandan tal cual al agente. null si no hay nada que proponer (una
    respuesta corta sin cambios no necesita "¿seguimos?"). */
export function preguntaFinal(messages) {
  const t = turno(messages);
  const ultimo = t[t.length - 1];
  if (!ultimo || ultimo.role !== 'assistant' || ultimo.error) return null;

  if (ultimo.plan) {
    return {
      texto: 'Plan listo. ¿Lo ejecuto?',
      opciones: [{ label: 'Sí, ejecútalo', plan: true }, { label: 'Ahora no' }],
    };
  }

  const pedido = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const fase = ultimaFase([pedido, ultimo.content]);
  if (fase > 0) {
    const sig = fase + 1;
    return {
      texto: `¡Fase ${fase} lista! ¿Continuar con la siguiente fase?`,
      opciones: [
        { label: `Sí, continúa con la fase ${sig}`, enviar: `Continúa con la fase ${sig}.` },
        { label: 'Revisa lo que hiciste primero', enviar: 'Antes de seguir, revisa y prueba lo que hiciste en esta fase.' },
        { label: 'Ahora no' },
      ],
    };
  }

  const hizoCambios = t.some((m) => m.role === 'tool' && /write|edit|append|insert|delete|rename|mkdir|run_command/.test(m.tool || ''));
  if (!hizoCambios) return null;
  return {
    texto: '¡Listo! ¿Seguimos con el siguiente paso?',
    opciones: [
      { label: 'Sí, continúa', enviar: 'Continúa con el siguiente paso.' },
      { label: 'Prueba lo que hiciste', enviar: 'Prueba lo que acabas de hacer y corrige lo que falle.' },
      { label: 'Ahora no' },
    ],
  };
}
