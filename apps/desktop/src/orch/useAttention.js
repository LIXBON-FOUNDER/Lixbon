import { useMemo } from 'react';
import { useOrchStore, taskTree } from '../store/orchStore';
import { usePendingSpawnsStore } from './spawn/pendingSpawnsStore';
import { attentionItems, unansweredQuestions } from './attention';

/** Todo lo que espera a la persona en cualquier repo, para avisar fuera del modo Orquestar. */
export function useAttentionTotals() {
  const snap = useOrchStore((s) => s.snap);
  const pending = usePendingSpawnsStore((s) => s.items.length);
  return useMemo(() => {
    const runs = Object.values(snap?.runs || {}).filter((r) => !r.closed);
    const tasks = attentionItems(runs.flatMap((r) => taskTree(snap?.tasks, r.id))).length;
    const questions = unansweredQuestions(snap?.messages).length;
    return { pending, tasks, questions, total: pending + tasks + questions };
  }, [snap, pending]);
}
