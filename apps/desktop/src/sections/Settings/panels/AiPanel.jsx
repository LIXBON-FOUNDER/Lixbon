// AiPanel.jsx — modelos de IA: autocompletado (FIM), visión y ventana de contexto.
import { useAppStore } from '../../../store/appStore';
import { Select } from '../../../components/Select';
import { detectVisionModel, modelId } from '../../../lib/vision';

export function AiPanel() {
  const {
    availableModels, currentModel,
    ghostText, setGhostText, ghostModel, setGhostModel,
    visionModel, setVisionModel,
    contextWindow, setContextWindow,
  } = useAppStore();

  // availableModels trae objetos {id,…}, no strings.
  const ids = (availableModels || []).map(modelId).filter(Boolean);
  const autoVision = (visionModel && ids.includes(visionModel))
    ? visionModel
    : detectVisionModel(availableModels || []);
  const autoGhost = ids.find((id) => /coder|code/i.test(id)) || currentModel;

  const modelOptions = (autoLabel) => [
    { value: '', label: `Automático (${autoLabel || 'ninguno'})` },
    ...ids.map((id) => ({ value: id, label: id })),
  ];

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Autocompletado con IA</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Sugerencias mientras escribes
            <span className="settings__row-hint">
              {' · '}texto en gris que Tab acepta; usa un modelo de código y consume VRAM
            </span>
          </span>
          <button
            className={`settings__toggle ${ghostText ? 'is-on' : ''}`}
            onClick={() => setGhostText(!ghostText)}
            role="switch"
            aria-checked={ghostText}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        {ghostText && (
          <div className="settings__inline settings__inline--spread">
            <span className="settings__row-label">
              Modelo de autocompletado
              <span className="settings__row-hint"> · idealmente uno con FIM (qwen2.5-coder…)</span>
            </span>
            <Select
              value={ghostModel}
              onChange={setGhostModel}
              options={modelOptions(autoGhost)}
            />
          </div>
        )}
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">Modelos</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Modelo de visión
            <span className="settings__row-hint">
              {' · '}describe las imágenes que adjuntas para el modelo de texto
              {autoVision ? '' : ' · instala uno en Ollama (p. ej. llava)'}
            </span>
          </span>
          <Select
            value={visionModel}
            onChange={setVisionModel}
            options={modelOptions(autoVision)}
          />
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Ventana de contexto
            <span className="settings__row-hint">
              {' · '}Ollama usa 4096 por defecto aunque el modelo soporte más. Más = menos cortes, pero más VRAM.
            </span>
          </span>
          <Select
            value={contextWindow}
            onChange={setContextWindow}
            options={[
              { value: 4096, label: '4096', hint: 'mínimo' },
              { value: 8192, label: '8192', hint: 'recomendado' },
              { value: 16384, label: '16384' },
              { value: 32768, label: '32768', hint: 'mucha VRAM' },
              { value: 65536, label: '65536', hint: 'solo GPUs grandes' },
            ]}
          />
        </div>
      </section>
    </>
  );
}
