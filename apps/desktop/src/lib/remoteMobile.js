import { CORE_RELAY_PROTOCOL, coreErrorCode } from './remoteCore.js';

const ACTIONS = new Set(['mobile_question', 'mobile_launch_approval', 'mobile_review', 'mobile_controls']);

/** Private relay operations: identity is supplied by the authenticated gateway, never args. */
export async function handleMobileAction(action, args, mobile, invoke, openDesktop) {
  const { rid, ...input } = args || {};
  if (!ACTIONS.has(action) || !/^[A-Za-z0-9_-]{1,64}$/.test(rid || '')
    || ![mobile?.user_id, mobile?.session_id].every((n) => Number.isSafeInteger(n) && n > 0)) return null;
  const fields = { rid, protocol: CORE_RELAY_PROTOCOL };
  try {
    let result = await invoke(`orch_${action}`, { userId: mobile.user_id, sessionId: mobile.session_id, args: input });
    if (action === 'mobile_review' && result?.outcome === 'desktop_requested') {
      const selection = result.selection;
      if (typeof openDesktop !== 'function' || selection?.attemptId !== input.attempt_id
        || ![selection?.projectId, selection?.taskId, selection?.attemptId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
        throw new Error('desktop_unavailable: no se pudo abrir el destino');
      }
      await openDesktop(selection);
      result = { outcome: 'desktop_opened', attempt_id: selection.attemptId };
    }
    return { type: `orch_${action}`, fields: { ...fields, ok: true, result } };
  } catch (error) {
    return { type: `orch_${action}`, fields: { ...fields, ok: false, code: coreErrorCode(error) } };
  }
}
