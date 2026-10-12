// HomeScreen.jsx — Inicio centrado en Attention (primer vertical slice).
//
//   Attention (arriba, con acciones)  ·  Proyectos con sus Tasks y estado  ·  Actividad reciente
//
// Cada sección es una consulta independiente al AdeClient: Attention hoy es del mock (G la llevará al Core),
// los proyectos serán reales con D, la actividad con E y las ejecuciones con el corte Task/Attempt. Cambiar
// la fuente de una no obliga a tocar las demás.
import { useAdeQuery } from '../../state/useAdeQuery';
import { useNow } from '../../state/useNow';
import { useLayout } from '../../layouts/layoutMode';
import { MobileAttentionConsole } from '../../layouts/MobileAttentionConsole';
import { AttentionInbox, ProjectsOverview, ActivityStrip } from './sections';
import { visibleAttention } from '../../domain-view/attention';
import { useState } from 'react';
import { ActionButton } from '../../components/ActionButton';
import { LaunchPanel } from '../../components/LaunchPanel';

export function useHomeQueries() {
  return {
    attentionQ: useAdeQuery((c) => c.listAttention(), []),
    projectsQ: useAdeQuery((c) => c.listProjects(), []),
    tasksQ: useAdeQuery((c) => c.listTasks(), []),
    attemptsQ: useAdeQuery((c) => c.listAttempts(), []),
    activityQ: useAdeQuery((c) => c.listActivity({ limit: 30 }), []),
  };
}

export function HomeScreen() {
  const { mode } = useLayout();
  const now = useNow();
  const q = useHomeQueries();
  const [lanzando, setLanzando] = useState(false);
  const compact = mode !== 'wide';
  const pendientes = Array.isArray(q.attentionQ.data) ? visibleAttention(q.attentionQ.data, now).length : 0;

  const attention = <AttentionInbox {...q} now={now} compact={compact} />;
  const projects = <ProjectsOverview {...q} now={now} onlyOpen />;
  const activity = <ActivityStrip activityQ={q.activityQ} projectsQ={q.projectsQ} now={now} limit={mode === 'wide' ? 12 : 8} />;

  if (mode === 'mobile') return <MobileAttentionConsole attention={attention} projects={projects} activity={activity} pendientes={pendientes} />;

  return (
    <div className="ade-home" data-testid="home">
      <div className="ade-home__main">
        <div className="ade-home__actions">
          <h1 className="ade-h1">Inicio</h1>
          <ActionButton intent="launch_task" label={lanzando ? 'Cancelar' : 'Lanzar trabajo nuevo'} variant="ghost" onClick={() => setLanzando((v) => !v)} />
        </div>
        {lanzando && <LaunchPanel onDone={() => setLanzando(false)} onCancel={() => setLanzando(false)} />}
        {attention}
        {projects}
      </div>
      <aside className="ade-home__side" aria-label="Actividad">{activity}</aside>
    </div>
  );
}
