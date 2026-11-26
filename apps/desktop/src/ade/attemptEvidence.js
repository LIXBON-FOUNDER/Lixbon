/** Un dato del Proof Pack solo se proyecta al intento y Task exactos de la selección. */
export function evidenceForAttempt(pack, attemptId, taskId) {
  return pack?.attempt_id === attemptId && pack?.task_id === taskId ? pack : null;
}

export function knownEvidence(evidence) {
  return ['verified', 'agent_reported'].includes(evidence?.provenance) && evidence.value !== null && evidence.value !== undefined;
}

export function evidenceObjective(pack) {
  const value = knownEvidence(pack?.objective) ? pack.objective.value?.objective : null;
  return typeof value === 'string' && value.trim() ? value : null;
}
