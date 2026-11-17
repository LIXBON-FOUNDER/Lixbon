export const QUESTION_ACTION = 'mobile_question';

export function questionLoad(result, attemptId) {
  if (!result.ok) return { code: result.code || 'offline' };
  const data = result.data?.result;
  if (data?.attempt_id !== attemptId || typeof data.task_id !== 'string' || !Array.isArray(data.questions)) {
    return { code: 'stale_question' };
  }
  const questions = data.questions.filter((q) => q?.kind === 'question' && typeof q.subject === 'string'
    && typeof q.request_id === 'string' && Number.isSafeInteger(q.asked_at));
  return questions.length ? { data: { ...data, questions } } : { code: 'stale_question' };
}

export function questionReply(result, attemptId, requestId) {
  if (!result.ok) return result.code || 'unconfirmed';
  const reply = result.data?.result;
  return reply?.status === 'Answered' && reply.attempt_id === attemptId && reply.request_id === requestId
    ? 'answered'
    : 'unconfirmed';
}
