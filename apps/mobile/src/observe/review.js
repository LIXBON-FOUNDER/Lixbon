export const REVIEW_ACTION = 'mobile_review';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const PROVENANCE = { verified: 'Verificado por el Core', agent_reported: 'Declarado por el agente', unknown: 'Sin evidencia' };

export function reviewReady(data, attemptId, attentionId) {
  const proof = data?.proof;
  const head = proof?.revision?.head_commit;
  return data?.attempt_id === attemptId && data?.review_id === attentionId && data.can_decide === true
    && head?.provenance === 'verified' && SHA.test(head.value || '') && proof.decision?.head_commit === head.value
    && proof.decision?.can_decide === true && data.diff?.readable === true && Array.isArray(data.diff.files)
    && ['allow', 'confirm'].includes(data.policy) && !proof.objective?.mobile_truncated && !proof.changes?.mobile_truncated;
}

export function reviewOutcome(result, attemptId, head, verdict) {
  if (!result.ok) return result.code || 'unconfirmed';
  const response = result.data?.result;
  if (response?.outcome === 'head_moved') return 'head_moved';
  return response?.outcome === 'recorded' && response.attempt_id === attemptId && response.head_commit === head && response.decision === verdict
    ? verdict : 'unconfirmed';
}
