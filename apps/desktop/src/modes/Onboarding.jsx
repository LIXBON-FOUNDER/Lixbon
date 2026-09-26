// Onboarding.jsx — tres pasos tras el primer inicio de sesión: modelo
// principal, autonomía del agente y carpeta de trabajo. Todo se puede cambiar
// después; "Omitir" deja los valores por defecto.
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useChatStore } from '../store/chatStore';
import { fetchModelRoles, roleModel } from '../lib/modelRoles';
import { pickDirectory, openExternal } from '../lib/tauri';
import { hasVsCode, importVsCode } from '../lib/vscodeImport';
import { ghStatus, ghUser } from '../lib/github';
import { Switch } from '../components/Switch';
import { IconCheck, IconChevronLeft, IconArrowRight } from '../components/Icons';

export const ONBOARDED_KEY = 'lixbon_onboarded';

const ROLE_COPY = {
  chat: ['Chat y agente', 'El que usa el agente para planificar, editar y ejecutar herramientas.'],
  fim: ['Autocompletado', 'Rápido: pensado para completar código mientras escribes.'],
  vision: ['Capturas y diseño', 'Entiende imágenes: útil en el modo Diseño.'],
};

const LEVELS = [
  {
    id: 'careful', title: 'Cauteloso', apply: { autoApprove: false, autoRunCommands: false },
    rules: [['Lee y busca por su cuenta', 'good'], ['Pregunta antes de editar', 'warn'], ['Pregunta antes de ejecutar', 'warn']],
  },
  {
    id: 'balanced', title: 'Equilibrado', apply: { autoApprove: true, autoRunCommands: false },
    rules: [['Lee y busca por su cuenta', 'good'], ['Edita y te deja revisar el diff', 'good'], ['Pregunta antes de ejecutar', 'warn']],
  },
  {
    id: 'auto', title: 'Autónomo', apply: { autoApprove: true, autoRunCommands: true },
    rules: [['Lee, edita y ejecuta', 'good'], ['Comandos sin preguntar', 'good'], ['Lo irreversible siempre pregunta', 'danger']],
  },
];

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

function describe(model, roles) {
  const role = Object.keys(ROLE_COPY).find((r) => roleModel(roles, r) === model.id);
  if (role) return ROLE_COPY[role];
  const caps = model.capabilities || [];
  if (caps.includes('vision')) return ROLE_COPY.vision;
  return ['General', caps.includes('tools') ? 'Sabe usar herramientas.' : 'Respuestas y explicaciones.'];
}

export function Onboarding({ onDone }) {
  const { currentModel, setCurrentModel, setAvailableModels, setModelRoles, workspaceRoot, openWorkspace, useCodebaseContext, setUseCodebaseContext } = useAppStore();
  const chat = useChatStore();
  const [step, setStep] = useState(0);
  const [models, setModels] = useState(null);
  const [roles, setRoles] = useState(null);
  const [level, setLevel] = useState(chat.autoApprove ? (chat.autoRunCommands ? 'auto' : 'balanced') : 'careful');
  const [folderError, setFolderError] = useState('');
  const [vscode, setVscode] = useState(null); // null = comprobando
  const [importIt, setImportIt] = useState(true);
  const [gh, setGh] = useState(null); // { status, login }

  useEffect(() => { hasVsCode().then(setVscode); }, []);
  // `gh` corre en la carpeta de trabajo: sin carpeta no se puede comprobar.
  useEffect(() => {
    if (!workspaceRoot) { setGh(null); return; }
    ghStatus().then(async (status) => setGh({ status, login: status === 'ok' ? await ghUser() : '' }));
  }, [workspaceRoot]);

  useEffect(() => {
    fetchModelRoles().then((r) => {
      const list = (r?.models || []).filter((m) => m.id !== roleModel(r, 'embed') && m.id !== roleModel(r, 'route'));
      setRoles(r);
      setModels(list);
      if (r) setModelRoles(r);
      if (r?.models?.length) setAvailableModels(r.models);
      if (list.length && !list.some((m) => m.id === currentModel)) {
        const preferred = roleModel(r, 'chat');
        setCurrentModel(list.some((m) => m.id === preferred) ? preferred : list[0].id);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = async () => {
    if (vscode && importIt) await importVsCode().catch(() => {});
    const preset = LEVELS.find((l) => l.id === level).apply;
    chat.setChatMode('agent');
    chat.setAutoApprove(preset.autoApprove);
    chat.setAutoRunCommands(preset.autoRunCommands);
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* sin almacenamiento: se repetirá */ }
    onDone();
  };

  const chooseFolder = async () => {
    setFolderError('');
    const dir = await pickDirectory({ title: 'Carpeta de trabajo' });
    if (!dir) return;
    try { await openWorkspace(dir); } catch (e) { setFolderError(String(e?.message || e)); }
  };

  return (
    <div className="onb">
      <header className="onb__top">
        <button className="lk" onClick={finish}>Omitir</button>
      </header>

      <div className="onb__body">
        <div className="onb__progress">
          <div className="onb__bars">
            {[0, 1, 2].map((i) => <span key={i} className="onb__bar"><span className={`onb__fill ${i <= step ? 'is-on' : ''}`} /></span>)}
          </div>
          <span className="mono onb__count">Paso {step + 1} de 3</span>
        </div>

        {step === 0 && (
          <section className="onb__step" key="model">
            <div className="onb__head rise"><span className="onb__h1">Elige tu modelo principal</span><span className="onb__sub">Lo puedes cambiar en cualquier momento desde el chat.</span></div>
            <div className="onb__cards">
              {models === null && [0, 1, 2].map((i) => <span key={i} className="skeleton onb__card onb__card--ghost" />)}
              {models?.length === 0 && <span className="onb__sub">No hay modelos disponibles ahora mismo. Podrás elegirlo desde el chat.</span>}
              {models?.slice(0, 3).map((m, i) => {
                const [title, desc] = describe(m, roles);
                return (
                  <button key={m.id} className={`onb__card rise rise--${i + 1} ${currentModel === m.id ? 'is-on' : ''}`} onClick={() => setCurrentModel(m.id)}>
                    <span className="onb__chk"><IconCheck size={12} /></span>
                    <span className="mono onb__model">{m.id}</span>
                    <span className="onb__cardtitle">{title}</span>
                    <span className="onb__carddesc">{desc}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="onb__step" key="level">
            <div className="onb__head rise"><span className="onb__h1">¿Cuánta autonomía le das al agente?</span><span className="onb__sub">Ajusta cada herramienta después en Agente y permisos.</span></div>
            <div className="onb__cards">
              {LEVELS.map((l, i) => (
                <button key={l.id} className={`onb__card rise rise--${i + 1} ${level === l.id ? 'is-on' : ''}`} onClick={() => setLevel(l.id)}>
                  <span className="onb__chk"><IconCheck size={12} /></span>
                  <span className="onb__cardtitle">{l.title}</span>
                  {l.rules.map(([t, tone]) => <span key={t} className="onb__rule"><span className={`dot dot--${tone}`} />{t}</span>)}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="onb__step" key="flow">
            <div className="onb__head rise"><span className="onb__h1">Conecta tu flujo</span><span className="onb__sub">Todo es opcional.</span></div>
            <div className="onb__rows rise rise--1">
              <div className="onb__row">
                <div className="onb__rowtext">
                  <span>Carpeta de trabajo</span>
                  <span className={`mono onb__rowsub ${folderError ? 'is-error' : ''}`}>{folderError || (workspaceRoot ? baseName(workspaceRoot) : 'Ninguna todavía')}</span>
                </div>
                <button className={`btn ${workspaceRoot ? 'btn--ghost' : 'btn--primary'}`} onClick={chooseFolder}>{workspaceRoot ? 'Cambiar' : 'Elegir'}</button>
              </div>
              <div className="onb__row">
                <div className="onb__rowtext">
                  <span>Contexto automático del código</span>
                  <span className="onb__rowsub">Indexa el proyecto y añade al chat los fragmentos relevantes.</span>
                </div>
                <Switch checked={useCodebaseContext} onChange={setUseCodebaseContext} label="Contexto automático del código" />
              </div>
              <div className="onb__row">
                <div className="onb__rowtext">
                  <span>Importar ajustes de VS Code</span>
                  <span className="onb__rowsub">{vscode === null ? 'Buscando…' : vscode ? 'Fuente, tabulación, terminal y los atajos que existen aquí.' : 'No encontré VS Code ni Cursor en este equipo.'}</span>
                </div>
                <Switch checked={!!vscode && importIt} onChange={setImportIt} disabled={!vscode} label="Importar ajustes de VS Code" />
              </div>
              <div className="onb__row">
                <div className="onb__rowtext">
                  <span>GitHub</span>
                  <span className={`onb__rowsub ${gh?.status === 'ok' ? 'is-ok' : ''}`}>
                    {!workspaceRoot ? 'Elige una carpeta para comprobarlo.'
                      : !gh ? 'Comprobando…'
                        : gh.status === 'ok' ? `${gh.login ? `@${gh.login} · ` : ''}conectado con GitHub CLI`
                          : gh.status === 'unauth' ? 'GitHub CLI instalado: inicia sesión con «gh auth login» en el terminal.'
                            : 'Pull requests, revisiones y checks dentro del IDE con GitHub CLI.'}
                  </span>
                </div>
                {gh?.status === 'missing' && <button className="btn btn--ghost" onClick={() => openExternal('https://cli.github.com')}>Instalar</button>}
                {gh?.status === 'ok' && <span className="dot dot--good" />}
              </div>
            </div>
          </section>
        )}

        <footer className="onb__nav">
          {step > 0 && <button className="lk" onClick={() => setStep(step - 1)}><IconChevronLeft size={14} /> Atrás</button>}
          <div className="panelhead__fill" />
          <button className={`btn ${step === 2 ? 'btn--accent' : 'btn--primary'} onb__next`} onClick={() => (step === 2 ? finish() : setStep(step + 1))}>
            {step === 2 ? 'Empezar' : 'Siguiente'} <IconArrowRight size={14} />
          </button>
        </footer>
      </div>
    </div>
  );
}
