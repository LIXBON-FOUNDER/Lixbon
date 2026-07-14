// IndexPanel.jsx — índice semántico del codebase (RAG): modelo de embeddings,
// construcción del índice y uso automático como contexto del chat.
import { useEffect } from 'react';
import { useAppStore } from '../../../store/appStore';
import { useIndexStore } from '../../../store/indexStore';
import { Select } from '../../../components/Select';
import { modelId } from '../../../lib/vision';

export function IndexPanel() {
  const {
    availableModels,
    embedModel, setEmbedModel,
    useCodebaseContext, setUseCodebaseContext,
  } = useAppStore();
  const {
    building, progress, status, error,
    build, cancel, refreshStatus,
  } = useIndexStore();

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const ids = (availableModels || []).map(modelId).filter(Boolean);
  const embedAuto = ids.find((id) => /embed/i.test(id));

  return (
    <section className="settings__panel">
      <h3 className="settings__panel-title">Índice del codebase (RAG)</h3>

      <div className="settings__inline settings__inline--spread">
        <span className="settings__row-label">
          Usar contexto del codebase en el chat
          <span className="settings__row-hint">
            {' · '}inyecta fragmentos relevantes por significado; requiere construir el índice
          </span>
        </span>
        <button
          className={`settings__toggle ${useCodebaseContext ? 'is-on' : ''}`}
          onClick={() => setUseCodebaseContext(!useCodebaseContext)}
          role="switch"
          aria-checked={useCodebaseContext}
        >
          <span className="settings__toggle-knob" />
        </button>
      </div>

      <div className="settings__inline settings__inline--spread">
        <span className="settings__row-label">
          Modelo de embeddings
          <span className="settings__row-hint">
            {embedAuto ? '' : ' · instala uno en Ollama: `ollama pull nomic-embed-text`'}
          </span>
        </span>
        <Select
          value={embedModel}
          onChange={setEmbedModel}
          options={[
            { value: '', label: `Automático (${embedAuto || 'ninguno'})` },
            ...ids.map((id) => ({ value: id, label: id })),
          ]}
        />
      </div>

      <div className="settings__inline settings__inline--spread">
        <span className="settings__row-label">
          Índice
          <span className="settings__row-hint">
            {' · '}
            {building
              ? `construyendo… ${progress.done}/${progress.total}`
              : status.exists
                ? `${status.count} fragmentos · modelo ${status.model}`
                : 'sin construir'}
            {error ? ` · ${error}` : ''}
          </span>
        </span>
        {building ? (
          <button className="settings__btn" onClick={cancel}>Cancelar</button>
        ) : (
          <button className="settings__btn" onClick={build} disabled={!embedAuto && !embedModel}>
            {status.exists ? 'Reconstruir' : 'Construir'}
          </button>
        )}
      </div>
    </section>
  );
}
