// ThreadScreen.jsx — el hilo lógico de una Task: mensajes del buzón (message_kind) de todos sus intentos.
// El Desktop local ve el texto; con la política `metadata-only` (predeterminada) otros clientes solo reciben metadatos.
import { useNow } from '../../state/useNow';
import { useThreadDetail } from './queries';
import { DetailBoundary, ScreenFrame } from './ScreenFrame';
import { Section } from '../../components/small';
import { EmptyState } from '../../components/states';
import { InlineAnswer } from '../../components/InlineAnswer';
import { NavLink } from '../../components/NavLink';
import { ActionButton } from '../../components/ActionButton';
import { formatAgo } from '../../domain-view/format';
import { routes } from '../../navigation/routes';
import { MESSAGE_KIND_LABELS } from '../../vocab/vocabulario';

const POLITICA = {
  'local-only': 'Solo local: nada de este hilo sale de esta máquina.',
  'metadata-only': 'Solo metadatos (predeterminada): otros clientes ven quién, cuándo y el tipo de mensaje, no el texto.',
  summary: 'Se sincroniza un resumen.',
  'full-transcript': 'Se sincroniza la transcripción completa (política explícita).',
};

export function ThreadScreen({ threadId }) {
  const q = useThreadDetail(threadId);
  const now = useNow();
  const route = routes.thread(threadId);
  return <DetailBoundary route={route} query={q}>{(d) => <ThreadBody route={route} d={d} now={now} />}</DetailBoundary>;
}

function ThreadBody({ route, d, now }) {
  const { thread, task, project, attempts } = d;
  const ordinal = Object.fromEntries(attempts.map((a) => [a.id, a.ordinal]));
  const abierta = attempts.find((a) => a.pendingQuestion);
  return (
    <ScreenFrame
      route={route} entities={{ project, task, thread }} title={thread.title}
      subtitle={<span className="ade-muted">{POLITICA[thread.syncPolicy] || thread.syncPolicy}</span>}
      actions={<ActionButton intent="continue_with_other_agent" args={{ attemptId: attempts.at(-1)?.id }} />}
    >
      <Section title="Mensajes" count={thread.messages.length} id="th-msgs">
        {thread.messages.length === 0 ? <EmptyState title="Este hilo aún no tiene mensajes">Los mensajes aparecerán cuando el agente informe fases, preguntas o su entrega.</EmptyState> : (
          <ol className="ade-msgs">
            {thread.messages.map((m) => (
              <li key={m.id} className={`ade-msg ade-msg--${m.kind}`} data-kind={m.kind}>
                <div className="ade-msg__head">
                  <span className="ade-msg__kind">{MESSAGE_KIND_LABELS[m.kind] || m.kind}</span>
                  <b>{m.author.label}</b>
                  {m.attemptId && <NavLink route={routes.attempt(m.attemptId)}>Intento {ordinal[m.attemptId] ?? '?'}</NavLink>}
                  <time>{formatAgo(m.at, now)}</time>
                </div>
                <p className="ade-msg__text">{m.text ?? <span className="ade-muted">(solo metadatos)</span>}</p>
              </li>
            ))}
          </ol>
        )}
      </Section>
      {abierta && <Section title="Responder" id="th-reply"><InlineAnswer attemptId={abierta.id} /></Section>}
    </ScreenFrame>
  );
}
