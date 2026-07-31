// AiPanel.jsx — modelos de IA: autocompletado (FIM), visión y ventana de contexto.
// Los desplegables se filtran por la capacidad que exige cada rol (según lo que
// declara Ollama), con un escape para ver el catálogo entero.
import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/appStore';
import { Select } from '../../../components/Select';
import { modelId } from '../../../lib/vision';
import { modelsForCapability, roleCapability, roleWarning } from '../../../lib/modelRoles';
import { resetFimAvailability } from '../../../lib/fim';

export function AiPanel() {
  const {
    availableModels, modelRoles, loadModelRoles,
    ghostText, setGhostText, ghostModel, setGhostModel,
    visionModel, setVisionModel,
    contextWindow, setContextWindow,
    effectiveGhostModel, effectiveVisionModel,
  } = useAppStore();
  // Escape cuando el filtro por capacidad esconde el modelo que el usuario
  // quiere (capabilities mal declaradas, modelo aún sin descargar…).
  const [verTodos, setVerTodos] = useState(false);

  // Abrir Ajustes es el momento en que el usuario mira estos valores: refrescar
  // aquí evita explicarle un estado obsoleto (el admin pudo reasignar un rol).
  useEffect(() => { loadModelRoles(); }, [loadModelRoles]);

  // availableModels trae objetos {id,…}, no strings.
  const ids = (availableModels || []).map(modelId).filter(Boolean);
  const autoGhost = effectiveGhostModel();
  const autoVision = effectiveVisionModel();

  // Con `modelRoles` cargado y sin modelo para `fim`, no hay nada que ofrecer:
  // el gateway ya dijo que ninguno declara `insert`.
  const fimSoportado = !modelRoles || !!modelRoles.roles?.fim?.model || !!ghostModel;
  const avisoFim = roleWarning(modelRoles, 'fim');

  const opciones = (capability, autoLabel) => {
    const aptos = (!verTodos && capability && modelRoles)
      ? modelsForCapability(availableModels || [], capability)
      : ids;
    const lista = aptos.length ? aptos : ids;
    return [
      { value: '', label: `Automático (${autoLabel || 'ninguno'})` },
      ...lista.map((id) => ({ value: id, label: id })),
    ];
  };

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Autocompletado con IA</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Sugerencias mientras escribes
            <span className="settings__row-hint">
              {fimSoportado
                ? `${' · '}texto en gris que Tab acepta; usa un modelo de código y consume VRAM`
                : `${' · '}${avisoFim || 'ningún modelo instalado soporta FIM (capacidad `insert`). Instala uno de código, p. ej. `ollama pull qwen2.5-coder:1.5b`'}`}
            </span>
          </span>
          <button
            className={`settings__toggle ${ghostText ? 'is-on' : ''}`}
            onClick={() => {
              // Al reactivarlo a mano, volver a permitir peticiones que el
              // gateway había cortado con 503 role_model_unavailable.
              if (!ghostText) resetFimAvailability();
              setGhostText(!ghostText);
            }}
            role="switch"
            aria-checked={ghostText}
            // Solo se bloquea el ENCENDIDO: si quedó activo de antes hay que
            // poder apagarlo, o el usuario se queda atrapado con él puesto.
            disabled={!fimSoportado && !ghostText}
            title={fimSoportado ? 'Activar autocompletado' : 'No hay ningún modelo con FIM disponible'}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        {ghostText && (
          <div className="settings__inline settings__inline--spread">
            <span className="settings__row-label">
              Modelo de autocompletado
              <span className="settings__row-hint">
                {' · '}debe soportar fill-in-the-middle (capacidad <code>insert</code>)
              </span>
            </span>
            <Select
              value={ghostModel}
              onChange={setGhostModel}
              options={opciones(roleCapability(modelRoles, 'fim'), autoGhost)}
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
            options={opciones(roleCapability(modelRoles, 'vision'), autoVision)}
          />
        </div>

        {modelRoles && (
          <div className="settings__inline settings__inline--spread">
            <span className="settings__row-label">
              Mostrar todos los modelos
              <span className="settings__row-hint">
                {' · '}sin filtrar por capacidad, por si un modelo la declara mal
              </span>
            </span>
            <button
              className={`settings__toggle ${verTodos ? 'is-on' : ''}`}
              onClick={() => setVerTodos(!verTodos)}
              role="switch"
              aria-checked={verTodos}
            >
              <span className="settings__toggle-knob" />
            </button>
          </div>
        )}

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
