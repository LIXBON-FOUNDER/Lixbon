// IndexPage.jsx — Ajustes → Índice del código: índice semántico del proyecto
// (RAG), su modelo de embeddings y si el chat lo usa como contexto.
import { useEffect } from 'react';
import { useAppStore } from '../../../store/appStore';
import { useIndexStore } from '../../../store/indexStore';
import { Select } from '../../../components/Select';
import { Switch } from '../../../components/Switch';
import { SpinRing } from '../../../components/Ring';
import { IconDatabase } from '../../../components/Icons';
import { modelId } from '../../../lib/vision';
import { modelsForCapability, roleCapability, roleWarning } from '../../../lib/modelRoles';
import { PageHead, SectionHead } from '../SettingsParts';

export function IndexPage() {
  const {
    availableModels, modelRoles, workspaceRoot,
    embedModel, setEmbedModel,
    useCodebaseContext, setUseCodebaseContext,
    effectiveEmbedModel,
  } = useAppStore();
  const { building, progress, status, error, build, cancel, refreshStatus } = useIndexStore();

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const ids = (availableModels || []).map(modelId).filter(Boolean);
  // El modelo lo resuelve el store (rol `embed` del gateway; heurístico solo si
  // el gateway es antiguo), y el aviso de qué instalar lo da el propio gateway.
  const embedAuto = effectiveEmbedModel();
  const capEmbed = roleCapability(modelRoles, 'embed');
  const aptos = (capEmbed && modelRoles) ? modelsForCapability(availableModels || [], capEmbed) : ids;
  const avisoEmbed = roleWarning(modelRoles, 'embed') || 'Instala uno en Ollama: ollama pull nomic-embed-text';
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="spage">
      <PageHead icon={IconDatabase} title="Índice del código" sub="Búsqueda por significado en tu proyecto, para que el chat encuentre el código relevante." />

      <section className="ssec rise rise--1">
        <SectionHead label="Índice de este proyecto" hint={workspaceRoot ? undefined : 'Abre una carpeta para construir su índice.'} />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Estado</span>
              <span className={`srow__hint ${error ? 'is-warn' : ''}`}>
                {building
                  ? `Construyendo… ${progress.done} de ${progress.total || '?'} fragmentos`
                  : error || (status.exists ? `${status.count} fragmentos · modelo ${status.model}` : 'Sin construir todavía.')}
              </span>
            </div>
            {building ? (
              <div className="ssec__actions">
                <SpinRing size={14} />
                <span className="mono srow__value">{pct}%</span>
                <button className="btn btn--ghost btn--sm" onClick={cancel}>Cancelar</button>
              </div>
            ) : (
              <button className="btn btn--ghost btn--sm" onClick={build} disabled={!workspaceRoot || (!embedAuto && !embedModel)}>
                {status.exists ? 'Reconstruir' : 'Construir índice'}
              </button>
            )}
          </div>
          {building && progress.total > 0 && (
            <div className="meter__track"><div className="meter__fill idx__fill" style={{ width: `${pct}%` }} /></div>
          )}
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Usar como contexto del chat</span>
              <span className="srow__hint">Añade a cada mensaje los fragmentos más parecidos a lo que preguntas.</span>
            </div>
            <Switch checked={useCodebaseContext} onChange={setUseCodebaseContext} label="Usar el índice como contexto" />
          </div>
        </div>
      </section>

      <section className="ssec rise rise--2">
        <SectionHead label="Modelo de embeddings" hint="Convierte el código en vectores. Si lo cambias, reconstruye el índice." />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Modelo</span>
              <span className={`srow__hint ${embedAuto ? '' : 'is-warn'}`}>{embedAuto ? 'Automático elige el que el clúster asigna al rol de embeddings.' : avisoEmbed}</span>
            </div>
            <Select
              value={embedModel}
              onChange={setEmbedModel}
              options={[
                { value: '', label: `Automático (${embedAuto || 'ninguno'})` },
                ...(aptos.length ? aptos : ids).map((id) => ({ value: id, label: id })),
              ]}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
