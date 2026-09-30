// ModelsPage.jsx — Ajustes → Modelos: el modelo del chat, qué modelo sirve
// cada rol en el clúster, el de visión y cuánto contexto se pide.
import { useEffect } from 'react';
import { useAppStore } from '../../../store/appStore';
import { ROLE_ORDER, roleModel, roleWarning, roleCapability, modelsForCapability } from '../../../lib/modelRoles';
import { modelId } from '../../../lib/vision';
import { Select } from '../../../components/Select';
import { Segmented } from '../../../components/Segmented';
import { IconCpu } from '../../../components/Icons';
import { PageHead, SectionHead } from '../SettingsParts';

const ROLE_COPY = {
  chat: ['Chat y agente', 'Conversación y herramientas del agente.'],
  fim: ['Autocompletado', 'Completar código mientras escribes.'],
  vision: ['Visión', 'Describe capturas e imágenes.'],
  embed: ['Embeddings', 'Índice semántico del código.'],
  route: ['Enrutado', 'Decide qué modelo responde cada mensaje.'],
};

const CONTEXTS = [8192, 16384, 32768, 65536];

export function ModelsPage() {
  const {
    availableModels, modelRoles, currentModel, setCurrentModel, loadModelRoles,
    visionModel, setVisionModel, effectiveVisionModel, contextWindow, setContextWindow,
  } = useAppStore();

  useEffect(() => { loadModelRoles().catch(() => {}); }, [loadModelRoles]);

  const ids = (availableModels || []).map(modelId).filter(Boolean);
  const capVision = roleCapability(modelRoles, 'vision');
  const visionIds = capVision && modelRoles ? modelsForCapability(availableModels, capVision) : ids;
  const contextValue = CONTEXTS.includes(contextWindow) ? contextWindow : CONTEXTS.reduce((a, b) => (Math.abs(b - contextWindow) < Math.abs(a - contextWindow) ? b : a));

  return (
    <div className="spage">
      <PageHead icon={IconCpu} title="Modelos" sub="Los modelos del clúster lixbon que usa este equipo." />

      <section className="ssec rise rise--1">
        <SectionHead label="Chat" />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Modelo del chat</span>
              <span className="srow__hint">El que responde en el chat y en el agente. También se cambia desde el propio chat.</span>
            </div>
            {ids.length
              ? <Select value={currentModel} onChange={setCurrentModel} options={ids.map((id) => ({ value: id, label: id }))} />
              : <span className="srow__hint">Sin modelos disponibles</span>}
          </div>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Modelo de visión</span>
              <span className="srow__hint">Describe las imágenes que adjuntes cuando el modelo del chat no las entiende.</span>
            </div>
            <Select
              value={visionModel}
              onChange={setVisionModel}
              options={[{ value: '', label: `Automático${effectiveVisionModel() ? ` · ${effectiveVisionModel()}` : ''}` }, ...visionIds.map((id) => ({ value: id, label: id }))]}
            />
          </div>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Contexto máximo</span>
              <span className="srow__hint">Cuánto texto cabe en cada petición. Más contexto recorta menos la conversación, pero usa más memoria y cupo.</span>
            </div>
            <Segmented
              size="sm"
              width={52}
              value={contextValue}
              onChange={setContextWindow}
              options={CONTEXTS.map((n) => ({ value: n, label: `${n / 1024}k` }))}
            />
          </div>
        </div>
      </section>

      <section className="ssec rise rise--2">
        <SectionHead label="Roles del clúster" hint="Qué modelo sirve cada tarea en el servidor. Los asigna el administrador según lo que sabe hacer cada modelo." />
        <div className="ssec ssec--card ssec--rows">
          {!modelRoles && <span className="srow__hint">El servidor no informa de sus roles; se eligen por el nombre del modelo.</span>}
          {modelRoles && ROLE_ORDER.map((role) => {
            const model = roleModel(modelRoles, role);
            const warning = roleWarning(modelRoles, role);
            const [label, hint] = ROLE_COPY[role] || [role, ''];
            return (
              <div key={role} className="srow">
                <div className="srow__text">
                  <span className="srow__label">{label}</span>
                  <span className={`srow__hint ${warning && !model ? 'is-warn' : ''}`}>{warning && !model ? warning : hint}</span>
                </div>
                <span className={`mono srow__value ${model ? '' : 'is-empty'}`}>{model || 'sin asignar'}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
