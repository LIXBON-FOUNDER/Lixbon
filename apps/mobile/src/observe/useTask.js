// observe/useTask.js — carga del Task Detail (LXO-110): detalle, Activity paginable y Attention relacionada,
// por el relé y con la identidad del IDE. Se vuelve a pedir cuando cambia la snapshot (llegaron Events).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { STATUS as BOOT } from './bootstrap';
import { activityReducer, initialActivity, snapshotTask, taskModel } from './task';

export const TASK_CAPABILITY = 'core_task';
const NOT_FOUND = /^(tasks_not_found|tasks_project_not_found)$/;

export function useTask(obs, { taskId, projectId: routeProject }) {
  const snapshot = obs.core?.snapshot;
  const snapItem = snapshotTask(snapshot, taskId);
  const projectId = routeProject || snapItem?.project_id || null;
  const capability = Array.isArray(obs.capabilities) && obs.capabilities.includes(TASK_CAPABILITY);
  const attentionCapability = Array.isArray(obs.capabilities) && obs.capabilities.includes('core_attention');
  const status = obs.core?.status;
  const online = obs.link === 'open' && obs.hostConnected && status !== BOOT.UNAUTHORIZED && status !== BOOT.VERSION_MISMATCH;
  const cursorKey = snapshot?.cursor?.events ?? null;

  const [detail, setDetail] = useState(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState(null);
  const [attention, setAttention] = useState(null);
  const [activity, dispatch] = useReducer(activityReducer, initialActivity);
  const activityRef = useRef(activity);
  activityRef.current = activity;

  const loadDetail = useCallback(async () => {
    if (!capability || !online || !projectId) return;
    const res = await obs.request('core_task', { project_id: projectId, task_id: taskId });
    if (res.ok) {
      setDetail(res.data.task);
      setMissing(false);
      setError(null);
    } else if (NOT_FOUND.test(res.code || '')) {
      // Invariante 4: una Task desaparecida es «no encontrada», nunca un crash.
      setDetail(null);
      setMissing(true);
    } else {
      setError(res.code || res.transport);
    }
  }, [capability, online, projectId, taskId, obs.request]);

  const loadActivity = useCallback(
    async (append) => {
      if (!capability || !online) return;
      const cursor = append ? activityRef.current.cursor : 0;
      if (append && !cursor) return;
      dispatch({ type: 'request' });
      const res = await obs.request('core_activity', { task_id: taskId, cursor });
      if (res.ok) dispatch({ type: 'page', append, items: res.data.items, cursor: res.data.next_cursor, hasMore: res.data.has_more });
      else dispatch({ type: 'fail', code: res.code || res.transport });
    },
    [capability, online, taskId, obs.request],
  );

  const loadAttention = useCallback(async () => {
    if (!attentionCapability || !online) return;
    const res = await obs.request('core_attention', { target_kind: 'task', target_id: taskId });
    if (res.ok) setAttention(res.data.items);
  }, [attentionCapability, online, taskId, obs.request]);

  useEffect(() => {
    loadDetail();
    loadActivity(false);
    loadAttention();
  }, [loadDetail, loadActivity, loadAttention, cursorKey]);

  const model = taskModel({ taskId, detail, snapItem, snapshot, missing });
  // Sin la lista propia, la Attention de esta Task que venga en la snapshot (las más urgentes).
  const related = attention ?? (snapshot?.attention?.items || []).filter((a) => a.target_kind === 'task' && a.target_id === taskId);
  return {
    model,
    activity,
    related,
    relatedPartial: attention === null,
    capability,
    online,
    error,
    more: () => loadActivity(true),
    refresh: () => {
      loadDetail();
      loadActivity(false);
      loadAttention();
    },
  };
}
