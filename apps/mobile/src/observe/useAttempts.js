// observe/useAttempts.js — los intentos de una Task (LXO-126) y la ficha de uno, por el relé y con la identidad
// del IDE. Solo con un IDE que anuncia `core_attempts` y un Core ya en el modelo Task/Attempt: si responde
// `core_model_inactive` (antes del corte) o el IDE es anterior, `mode` es 'legacy' y la pantalla sigue como en
// LXO-110. Se vuelve a pedir cuando cambia la snapshot (llegaron Events). Sin conexión enseña lo último que vio,
// marcado como desactualizado.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { ATTEMPTS_CAPABILITY, createAttemptsMemory } from './attempts';
import { STATUS as BOOT } from './bootstrap';
import { activityReducer, initialActivity } from './task';

const LEGACY = /^(core_model_inactive|unsupported_action|invalid_request)$/;
const NOT_FOUND = /^model_not_found$/;
const memory = createAttemptsMemory();

function useOnline(obs) {
  const status = obs.core?.status;
  return obs.link === 'open' && obs.hostConnected && status !== BOOT.UNAUTHORIZED && status !== BOOT.VERSION_MISMATCH;
}

/** La Attention de intentos: la lista propia si el IDE la da; si no, la de la snapshot (las más urgentes). */
function useAttemptAttention(obs, online, args, key) {
  const capability = Array.isArray(obs.capabilities) && obs.capabilities.includes('core_attention');
  const [items, setItems] = useState(null);
  const load = useCallback(async () => {
    if (!capability || !online) return;
    const res = await obs.request('core_attention', { target_kind: 'attempt', ...args, limit: 100 });
    if (res.ok) setItems(res.data.items);
  }, [capability, online, obs.request, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const fallback = (obs.core?.snapshot?.attention?.items || []).filter((a) => a.target_kind === 'attempt');
  return { attention: items ?? fallback, partial: items === null, load };
}

export function useAttempts(obs, taskId) {
  const capability = Array.isArray(obs.capabilities) && obs.capabilities.includes(ATTEMPTS_CAPABILITY);
  const online = useOnline(obs);
  const cursorKey = obs.core?.snapshot?.cursor?.events ?? null;
  const key = `task:${taskId}`;
  const [entry, setEntry] = useState(() => memory.recall(key));
  const [mode, setMode] = useState(capability ? null : 'legacy');
  const [error, setError] = useState(null);
  const att = useAttemptAttention(obs, online, {}, key);

  const load = useCallback(async () => {
    if (!capability) {
      setMode('legacy');
      return;
    }
    if (!online) return;
    const res = await obs.request('core_attempts', { task_id: taskId });
    if (res.ok) {
      const next = { data: { task: res.data.task, attempts: res.data.attempts || [], truncated: !!res.data.truncated }, at: Date.now() };
      memory.remember(key, next);
      setEntry(next);
      setMode('v2');
      setError(null);
    } else if (LEGACY.test(res.code || '')) {
      setMode('legacy');
    } else if (NOT_FOUND.test(res.code || '')) {
      setEntry(null);
      setMode('legacy');
    } else {
      setError(res.code || res.transport);
    }
  }, [capability, online, taskId, key, obs.request]);

  useEffect(() => {
    load();
    att.load();
  }, [load, att.load, cursorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // Con lo guardado de antes, se enseña aunque aún no haya respuesta: sale marcado como desactualizado.
    mode: mode ?? (entry ? 'v2' : null),
    data: entry?.data || null,
    at: entry?.at || null,
    stale: !!entry && (!online || !!error || mode === null),
    online,
    attention: att.attention,
    attentionPartial: att.partial,
    refresh: () => {
      load();
      att.load();
    },
  };
}

export function useAttempt(obs, attemptId) {
  const capability = Array.isArray(obs.capabilities) && obs.capabilities.includes(ATTEMPTS_CAPABILITY);
  const online = useOnline(obs);
  const cursorKey = obs.core?.snapshot?.cursor?.events ?? null;
  const key = `attempt:${attemptId}`;
  const [entry, setEntry] = useState(() => memory.recall(key));
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(false);
  const att = useAttemptAttention(obs, online, { target_id: attemptId }, key);
  // La Activity de este intento (LXO-127): `core_activity` con `attempt_id`.
  const [activity, dispatch] = useReducer(activityReducer, initialActivity);
  const activityRef = useRef(activity);
  activityRef.current = activity;

  const loadActivity = useCallback(
    async (append) => {
      if (!capability || !online) return;
      const cursor = append ? activityRef.current.cursor : 0;
      if (append && !cursor) return;
      dispatch({ type: 'request' });
      const res = await obs.request('core_activity', { attempt_id: attemptId, cursor });
      if (res.ok) dispatch({ type: 'page', append, items: res.data.items, cursor: res.data.next_cursor, hasMore: res.data.has_more });
      else dispatch({ type: 'fail', code: res.code || res.transport });
    },
    [capability, online, attemptId, obs.request],
  );

  const load = useCallback(async () => {
    if (!capability || !online) return;
    const res = await obs.request('core_attempt', { attempt_id: attemptId });
    if (res.ok) {
      const next = { attempt: res.data.attempt, task: res.data.task || null, at: Date.now() };
      memory.remember(key, next);
      setEntry(next);
      setMissing(false);
      setError(null);
      setFresh(true);
    } else if (NOT_FOUND.test(res.code || '')) {
      setEntry(null);
      setMissing(true);
    } else {
      setError(res.code || res.transport);
    }
  }, [capability, online, attemptId, key, obs.request]);

  useEffect(() => {
    load();
    att.load();
    loadActivity(false);
  }, [load, att.load, loadActivity, cursorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    capability,
    attempt: entry?.attempt || null,
    task: entry?.task || null,
    activity,
    more: () => loadActivity(true),
    at: entry?.at || null,
    stale: !!entry && (!online || !!error || !fresh),
    missing,
    error,
    online,
    attention: att.attention.filter((a) => a.target_id === attemptId),
    attentionPartial: att.partial,
  };
}
