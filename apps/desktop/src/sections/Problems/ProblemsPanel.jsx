// ProblemsPanel.jsx — lista de diagnósticos del linter (A2). Clic salta a la línea.
import { useEffect } from 'react';
import { useProblemsStore } from '../../store/problemsStore';
import { useEditorStore } from '../../store/editorStore';
import { IconRefresh, IconWarn } from '../../components/Icons';

export function ProblemsPanel() {
  const { diagnostics, running, error, path, name, run } = useProblemsStore();
  const activePath = useEditorStore((s) => s.activePath);

  // Analiza al abrir el panel y al cambiar de archivo activo.
  useEffect(() => { run(); }, [activePath, run]);

  const jump = (d) => {
    if (!path) return;
    useEditorStore.getState().openFileAtLine(path, name, d.line || 1);
  };

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warns = diagnostics.length - errors;

  return (
    <div className="outline">
      <div className="scm__head">
        <span className="scm__title">Problemas</span>
        <button className="icon-btn" onClick={run} title="Analizar archivo activo" disabled={running}>
          <IconRefresh size={15} />
        </button>
      </div>

      {running && <p className="settings__hint">Analizando…</p>}
      {error && <p className="settings__status is-error">{error}</p>}

      {!running && !error && (
        <>
          <p className="settings__hint">
            {diagnostics.length === 0
              ? 'Sin problemas. Pulsa actualizar para analizar el archivo.'
              : `${errors} ${errors === 1 ? 'error' : 'errores'} · ${warns} ${warns === 1 ? 'aviso' : 'avisos'}`}
          </p>
          <div className="outline__list">
            {diagnostics.map((d, i) => (
              <button key={i} className="problem__item" onClick={() => jump(d)} title={d.message}>
                <span className={`problem__sev problem__sev--${d.severity}`}>
                  <IconWarn size={13} />
                </span>
                <span className="problem__msg">{d.message}</span>
                <span className="outline__line">{d.line}:{d.col}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
