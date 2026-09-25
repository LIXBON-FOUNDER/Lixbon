// Welcome.jsx — inicio sin carpeta abierta: describir lo que se quiere
// construir, abrir o clonar un proyecto, o retomar uno reciente.
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useChatStore } from '../store/chatStore';
import { useGitStore } from '../store/gitStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { pickDirectory, getAppVersion } from '../lib/tauri';
import { showConfirm } from '../lib/confirm';
import { LogoMark } from '../components/Logo';
import { SpinRing } from '../components/Ring';
import { IconFolderOpen, IconGitBranch, IconArrowUp, IconX, IconPlus } from '../components/Icons';

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

export function Welcome({ onSkip }) {
  const { recentFolders, openWorkspace, removeRecent, connectionStatus } = useAppStore();
  const cloning = useGitStore((s) => s.cloning);
  const cloneProgress = useGitStore((s) => s.cloneProgress);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');

  useEffect(() => { getAppVersion().then(setVersion).catch(() => {}); }, []);

  const open = async (path) => {
    setError('');
    try { await openWorkspace(path); } catch (e) { setError(String(e)); }
  };

  const browse = async () => {
    const dir = await pickDirectory({ title: 'Abrir carpeta de trabajo' });
    if (dir) await open(dir);
  };

  const clone = async () => {
    const { choice, value } = await showConfirm({
      title: 'Clonar repositorio',
      message: 'URL del repositorio (HTTPS o SSH).',
      input: { value: '', placeholder: 'https://github.com/usuario/proyecto.git' },
      options: [{ id: 'ok', label: 'Elegir destino…', kind: 'primary' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'ok' || !value?.trim()) return;
    const dest = await pickDirectory({ title: 'Carpeta donde clonar' });
    if (!dest) return;
    const res = await useGitStore.getState().cloneRepo(value.trim(), dest);
    if (res.ok) await open(res.target);
    else setError(res.error);
  };

  const newProject = async () => {
    const { choice, value } = await showConfirm({
      title: 'Proyecto nuevo',
      message: 'Cuéntale al agente qué quieres construir. Después eliges una carpeta vacía y lo monta ahí.',
      input: { value: text.trim(), placeholder: 'Una landing en Astro con blog y modo oscuro' },
      options: [{ id: 'ok', label: 'Elegir carpeta…', kind: 'primary' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'ok' || !value?.trim()) return;
    const dir = await pickDirectory({ title: 'Carpeta vacía para el proyecto nuevo' });
    if (!dir) return;
    setError('');
    try {
      await openWorkspace(dir);
    } catch (e) {
      setError(String(e));
      return;
    }
    await useGitStore.getState().init().catch(() => {});
    useWorkbenchStore.getState().setMode('agent');
    useChatStore.getState().send(
      `Proyecto nuevo en esta carpeta (vacía, ya con git init): ${value.trim()}.\n\n`
      + 'Elige un stack actual y sencillo salvo que te haya dicho otro, crea la estructura y los archivos, '
      + 'y dime qué comandos instalan las dependencias y lo arrancan (los ejecuto yo o me pides permiso).',
    );
  };

  const start = () => {
    const t = text.trim();
    if (!t) return;
    useWorkbenchStore.getState().setMode('agent');
    onSkip();
    useChatStore.getState().send(t);
  };

  return (
    <div className="welcome">
      <div className="welcome__glow welcome__glow--a" />
      <div className="welcome__glow welcome__glow--b" />
      <div className="welcome__inner">
        <div className="welcome__brand rise"><LogoMark size={34} /><span className="brand">lixbon</span></div>
        <p className="welcome__lead rise rise--1">¿Qué construimos hoy?</p>

        <div className="welcome__box rise rise--2">
          <textarea
            rows={3}
            value={text}
            placeholder="Describe lo que quieres construir o pregunta lo que necesites"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); } }}
          />
          <div className="welcome__boxrow">
            <span className="welcome__hint">Sin carpeta el agente solo conversa; ábrela para que edite archivos.</span>
            <button className="chat-inputbar__send" onClick={start} disabled={!text.trim()} aria-label="Empezar"><IconArrowUp size={16} /></button>
          </div>
        </div>

        <div className="welcome__actions rise rise--2">
          <button className="lk" onClick={browse}><IconFolderOpen size={14} /> Abrir carpeta <kbd>Ctrl O</kbd></button>
          <button className="lk" onClick={clone} disabled={cloning}>
            {cloning ? <SpinRing size={12} /> : <IconGitBranch size={14} />} {cloning ? cloneProgress || 'Clonando…' : 'Clonar repositorio'}
          </button>
          <button className="lk" onClick={newProject}><IconPlus size={14} /> Proyecto nuevo</button>
          <button className="lk" onClick={onSkip}>Continuar sin carpeta</button>
        </div>
        {error && <p className="welcome__error">{error}</p>}

        {recentFolders.length > 0 && (
          <div className="welcome__recents rise rise--3">
            <span className="welcome__label">Recientes</span>
            {recentFolders.map((p) => (
              <div key={p} className="welcome__recent">
                <button className="lk welcome__recentbtn" onClick={() => open(p)}>
                  <span className="welcome__recentname">{baseName(p)}</span>
                  <span className="mono welcome__recentpath">{p}</span>
                </button>
                <button className="ic" onClick={() => removeRecent(p)} aria-label="Quitar de recientes"><IconX size={12} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="welcome__foot mono">
        {version && <span>v{version}</span>}
        <span className={`statusbar__conn is-${connectionStatus}`}><span className="dot" /> {connectionStatus === 'connected' ? 'Clúster conectado' : 'Sin conexión con el clúster'}</span>
      </div>
    </div>
  );
}
