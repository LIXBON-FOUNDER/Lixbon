// ProblemsPanel.jsx — diagnósticos del linter (A2). Vive en el dock inferior,
// junto al Terminal. Clic en una fila salta a la línea del editor.
import { useEffect } from 'react';
import { useProblemsStore } from '../../store/problemsStore';
import { useEditorStore } from '../../store/editorStore';
import { useAppStore } from '../../store/appStore';
import { IconRefresh, IconWarn, IconCheck } from '../../components/Icons';

export function ProblemsPanel() {
  const { diagnostics, running, error, path, name, run } = useProblemsStore();
  const activePath = useEditorStore((s) => s.activePath);
  const visible = useAppStore((s) => s.bottomView === 'problems');

  // Analiza al cambiar de archivo activo, pero solo con la pestaña a la vista:
  // el panel sigue montado tras el Terminal y el linter lanza un proceso.
  useEffect(() => {
    if (visible) run();
  }, [activePath, visible, run]);

  const jump = (d) => {
    if (!path) return;
    useEditorStore.getState().openFileAtLine(path, name, d.line || 1);
  };

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warns = diagnostics.length - errors;

  return (
    <div className="problems">
      <div className="problems__bar">
        <span className="problems__summary">
          {running
            ? 'Analizando…'
            : name
              ? `${name} · ${errors} ${errors === 1 ? 'error' : 'errores'}, ${warns} ${warns === 1 ? 'aviso' : 'avisos'}`
              : 'Abre un archivo para analizarlo.'}
        </span>
        <button className="icon-btn" onClick={run} title="Analizar archivo activo" disabled={running}>
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="problems__list">
        {error && <p className="problems__empty is-error">{error}</p>}

        {!error && !running && diagnostics.length === 0 && (
          <p className="problems__empty">
            <IconCheck size={14} /> Sin problemas detectados.
          </p>
        )}

        {!error && diagnostics.map((d, i) => (
          <button key={i} className="problem__item" onClick={() => jump(d)} title={d.message}>
            <span className={`problem__sev problem__sev--${d.severity}`}>
              <IconWarn size={13} />
            </span>
            <span className="problem__msg">{d.message}</span>
            <span className="problem__loc">{name} [{d.line}:{d.col}]</span>
          </button>
        ))}
      </div>
    </div>
  );
}
