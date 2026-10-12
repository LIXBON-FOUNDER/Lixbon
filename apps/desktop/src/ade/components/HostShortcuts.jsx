// HostShortcuts.jsx — atajos al diff, el worktree, el IDE y la terminal de un intento.
// Son intents del HOST (capacidades del cliente), no del Core. Con el NullHost de la vista previa salen
// como «no disponibles» con su motivo; cuando el shell implemente AdeHost, funcionan sin tocar esto.
import { ActionButton } from './ActionButton';

const ATAJOS = ['open_diff', 'open_worktree', 'open_in_ide', 'open_terminal'];

export function HostShortcuts({ attemptId, only = ATAJOS }) {
  return (
    <div className="ade-shortcuts" role="group" aria-label="Atajos al IDE">
      {only.map((intent) => <ActionButton key={intent} intent={intent} args={{ attemptId }} />)}
    </div>
  );
}
