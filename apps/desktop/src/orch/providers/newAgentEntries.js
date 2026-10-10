// newAgentEntries.js — entradas de proveedores en "+ Nuevo" del modo Agente (el
// "Agente de Lixbon" va fijo aparte). Salen de orch_list_providers.
import { providerLabel } from './providersContract';

/** Motores de chat que Lixbon sabe abrir (chatStore.spawnSession). Codex no tiene chat propio todavía. */
export const CHAT_ENGINES = Object.freeze(['claude']);
export const NO_CHAT_REASON = 'chat aún no disponible';
/** Codex no abre chat: abre una pestaña con su TUI en un PTY (orch/codexterm). */
export const TERMINAL_ENGINES = Object.freeze(['codex']);

/**
 * Claude se muestra aunque la lista no llegue (su chat no depende del orquestador).
 * Un proveedor no disponible sale deshabilitado con su disabled_reason; nunca se oculta.
 */
export function newAgentEntries(providers) {
  const list = providers?.length ? providers : [{ id: 'claude', available: true }, { id: 'codex', available: false }];
  return list.map((p) => withWarnings(p, entryOf(p)));
}

/** Avisos del proveedor (orch_list_providers.warnings) y perfiles bloqueados, para mostrarlos en el menú. */
function withWarnings(p, e) {
  return { ...e, warnings: Array.isArray(p.warnings) ? p.warnings : [], blocked: Array.isArray(p.blocked_profiles) ? p.blocked_profiles : [] };
}

function entryOf(p) {
  const hasChat = CHAT_ENGINES.includes(p.id);
  const off = p.available ? null : p.disabled_reason || 'no disponible';
  // El chat de Claude Code no pasa por el orquestador: su motivo se muestra pero no se
  // bloquea (antes siempre se podía abrir; una versión sin verificar no lo impide).
  if (hasChat) return { id: p.id, label: providerLabel(p.id), disabled: false, reason: off, kind: 'chat' };
  if (TERMINAL_ENGINES.includes(p.id)) return { id: p.id, label: providerLabel(p.id), disabled: !p.available, reason: off, kind: 'terminal' };
  return { id: p.id, label: providerLabel(p.id), disabled: true, reason: off || NO_CHAT_REASON };
}

/** ¿Se puede abrir un chat con este motor? Guarda final antes de llamar a newSession. */
export const canOpenChat = (id) => id === 'lixbon' || CHAT_ENGINES.includes(id);
