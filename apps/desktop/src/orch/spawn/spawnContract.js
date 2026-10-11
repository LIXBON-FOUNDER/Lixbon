// spawnContract.js — contrato con el host para los lanzamientos pendientes del orquestador.
// Cuando el coordinador ejecuta `lxo spawn`, el host deja el lanzamiento PENDIENTE hasta que
// la persona lo aprueba o lo rechaza aquí. Los comandos son Tauri propios (no pasan por
// orch_call ni por HTTP), así que un agente no puede aprobarse a sí mismo.
// Todos los nombres del contrato viven en este archivo: si el host los cambia, se renombran aquí.
// El mock de ./mockPendingSpawns.js solo se carga si import.meta.env.DEV y VITE_ORCH_MOCK === '1'.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const SPAWN_EVENTS = Object.freeze({
  pending: 'orch-spawn-pending',   // payload: PendingSpawn
  // payload: { pending_id, outcome, decision, task?, reason? } (host b2aa870, approval.rs resolved_payload)
  resolved: 'orch-spawn-resolved',
});

export const SPAWN_COMMANDS = Object.freeze({
  list: 'orch_list_pending_spawns',
  approve: 'orch_approve_spawn',
  reject: 'orch_reject_spawn',
});

export const SPAWN_OUTCOMES = Object.freeze({
  approved: 'approved',
  rejected: 'rejected',
  expired: 'expired',             // venció, el coordinador terminó o el run se borró (sin decisión)
  launchFailed: 'launch_failed',  // la persona aprobó pero el host no pudo lanzar: NO es un rechazo
  alreadyResolved: 'already_resolved',
});

/** Nombres de campos del pendiente y de los argumentos. */
export const SPAWN_FIELDS = Object.freeze({
  pendingId: 'pending_id',
  parentTask: 'parent_task',
  run: 'run',
  title: 'title',
  model: 'model',
  effort: 'effort',
  cwd: 'cwd',          // carpeta donde correrá la hija (worktree aún sin crear o la del coordinador)
  shared: 'shared',
  createdAt: 'created_at',
  agent: 'agent',
  provider: 'provider',
  profile: 'profile',
  role: 'role',
  specSummary: 'spec_summary',
  expiresAt: 'expires_at', // ms desde epoch (u64) en el host; se acepta también ISO
  task: 'task',
  decision: 'decision',
  policy: 'policy',
  env: 'env', // { shared, copy, skipped }: lo que el worktree nuevo se llevaría del repo
  integrateInto: 'integrate_into', // { dir, branch } | null (null = compartida, sin rama)
  outcome: 'outcome',
  confirm: 'confirm',
  argv: 'argv',
  ackUnverified: 'ack_unverified',
  reason: 'reason',
});

const F = SPAWN_FIELDS;
export const spawnField = (obj, key) => (obj ? obj[F[key]] : undefined);

/** expires_at/created_at a milisegundos: el host manda un número (ms epoch). */
export function toMs(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return Date.parse(v);
}

/** Texto del destino de integración: el host manda { dir, branch }; se acepta un texto. */
export function integrateIntoLabel(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.branch || v.dir || null;
  return null;
}

/** Motivo de un resultado: `reason` del payload o `launch_error` de la decisión registrada. */
export function resolvedReason(r) {
  return r?.reason ?? r?.decision?.detail?.launch_error ?? r?.decision?.detail?.reason ?? null;
}

/** Política completa para EffectivePolicyView: el host manda argv/status/warnings/cli_version
    y el pendiente aporta proveedor, perfil y rol. */
export function pendingPolicy(item) {
  const p = spawnField(item, 'policy') || {};
  return {
    profile: p.profile ?? spawnField(item, 'profile'),
    provider: p.provider ?? spawnField(item, 'provider'),
    role: p.role ?? spawnField(item, 'role') ?? null,
    argv: Array.isArray(p.argv) ? p.argv : [],
    cli_version: p.cli_version ?? null,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    status: p.status,
    reason: p.reason ?? null,
  };
}

const useMock = () => import.meta.env.DEV && import.meta.env.VITE_ORCH_MOCK === '1';

export async function listPendingSpawns() {
  if (useMock()) return (await import('./mockPendingSpawns.js')).mockListPendingSpawns();
  return invoke(SPAWN_COMMANDS.list);
}

/** @param {{ pending_id: string, argv: string[], ack_unverified: boolean }} a */
export async function approveSpawn(a) {
  const payload = { [F.pendingId]: a.pending_id, [F.confirm]: true, [F.argv]: a.argv, [F.ackUnverified]: a.ack_unverified === true };
  if (useMock()) return (await import('./mockPendingSpawns.js')).mockApproveSpawn(payload);
  return invoke(SPAWN_COMMANDS.approve, payload);
}

/** @param {{ pending_id: string, reason?: string }} a */
export async function rejectSpawn(a) {
  const payload = { [F.pendingId]: a.pending_id, [F.confirm]: true };
  const reason = String(a.reason ?? '').trim();
  if (reason) payload[F.reason] = reason;
  if (useMock()) return (await import('./mockPendingSpawns.js')).mockRejectSpawn(payload);
  return invoke(SPAWN_COMMANDS.reject, payload);
}

/** Suscribe a los dos eventos; devuelve una función para desuscribir. */
export function subscribeSpawns({ onPending, onResolved }) {
  if (useMock()) return () => {};
  const offs = [listen(SPAWN_EVENTS.pending, (e) => onPending(e.payload)), listen(SPAWN_EVENTS.resolved, (e) => onResolved(e.payload))];
  return () => offs.forEach((p) => Promise.resolve(p).then((off) => off?.()).catch(() => {}));
}

export const defaultSpawnApi = { list: listPendingSpawns, approve: approveSpawn, reject: rejectSpawn, subscribe: subscribeSpawns };
