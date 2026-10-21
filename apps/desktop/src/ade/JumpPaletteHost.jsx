import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { JumpPalette } from './JumpPalette';
import { useJumpPaletteData, useJumpPaletteRecents } from './jumpPaletteData';

/** Etiqueta cada Attention con datos del Core por ID exacto (Task/Project del mismo conjunto); nunca por ruta ni rama. */
export function buildAttentionResults(attention, tasks, projects) {
  const taskTitles = new Map(tasks.map((task) => [`${task.projectId}\u0000${task.id}`, task.title]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return attention.map((item) => {
    let title = '';
    if (item.targetKind === 'task' && item.projectId) title = taskTitles.get(`${item.projectId}\u0000${item.targetId}`) ?? '';
    else if (item.targetKind === 'project') title = projectNames.get(item.targetId) ?? '';
    return {
      ...item,
      title: title || `${item.category} · ${item.targetKind} ${item.targetId}`,
      facts: [
        `Destino ${item.targetKind}`,
        `Severidad ${item.severity || 'no informada'}`,
        item.projectId ? `Project ${item.projectId}` : 'Sin Project',
      ],
    };
  });
}

function staleMessage(target) {
  const subject = target.kind === 'project'
    ? `El Project ${target.projectId}`
    : target.kind === 'task'
      ? `La Task ${target.taskId} (Project ${target.projectId})`
      : `La Attention ${target.attentionId}`;
  return `${subject} ya no está en los resultados actuales de Core. Actualiza los resultados para continuar.`;
}

/**
 * Anfitrión del Jump Palette dentro del ADE: lee Core solo mientras está abierta, rechaza destinos que ya no están
 * en el último conjunto autoritativo y delega la navegación en `onNavigate(target)`, que devuelve
 * `{ ok: true }` o `{ ok: false, message }` (la paleta queda abierta con el aviso). Los destinos abiertos con éxito se
 * recuerdan solo en el cliente (IDs durables en localStorage); nunca se escriben en Core.
 */
export function JumpPaletteHost({ open, onClose, onNavigate }) {
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState(null);
  const { data, refresh, hasTarget } = useJumpPaletteData(open);
  const { recents, remember } = useJumpPaletteRecents(open, data);
  const ideOverlayOpen = useAppStore((s) => s.quickOpen || s.commandPalette);

  useEffect(() => {
    if (open) return;
    setQuery('');
    setNotice(null);
  }, [open]);

  // Ctrl+P / Ctrl+Mayús+P abren sus propias paletas: esta cede el foco en vez de apilarse.
  useEffect(() => {
    if (open && ideOverlayOpen) onClose?.();
  }, [open, ideOverlayOpen, onClose]);

  const attention = useMemo(
    () => buildAttentionResults(data.attention, data.tasks, data.projects),
    [data.attention, data.tasks, data.projects],
  );

  const changeQuery = useCallback((value) => {
    setQuery(value);
    setNotice(null);
  }, []);

  const navigate = useCallback((target) => {
    if (!hasTarget(target)) {
      setNotice({
        message: staleMessage(target),
        actionLabel: 'Actualizar resultados',
        onAction: () => { setNotice(null); refresh(); },
      });
      return false;
    }
    const outcome = onNavigate(target);
    if (outcome?.ok === false) {
      setNotice({ message: outcome.message });
      return false;
    }
    remember(target);
    return true;
  }, [hasTarget, onNavigate, refresh, remember]);

  const hasResults = data.projects.length > 0 || data.tasks.length > 0 || data.attention.length > 0;
  const loading = data.phase === 'loading' && !hasResults;
  const notes = [...data.issues];
  if (data.phase === 'loading' && hasResults && data.progress.total > 0 && data.progress.done < data.progress.total) {
    notes.push(`Cargando Tasks: ${data.progress.done}/${data.progress.total} Projects.`);
  }
  let shownNotice = notice;
  if (!shownNotice && data.phase === 'error') {
    shownNotice = {
      message: `No se pudieron leer los resultados de Core (${data.error}).`,
      actionLabel: 'Reintentar',
      onAction: refresh,
    };
  }

  return (
    <JumpPalette
      open={open}
      query={query}
      onQueryChange={changeQuery}
      loading={loading}
      statusNote={notes.join(' ')}
      notice={shownNotice}
      projects={data.projects}
      tasks={data.tasks}
      attention={attention}
      recents={recents}
      onNavigate={navigate}
      onClose={onClose}
    />
  );
}
