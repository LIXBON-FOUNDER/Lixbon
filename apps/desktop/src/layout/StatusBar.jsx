// StatusBar.jsx — barra de estado inferior (estilo VSCode).
//
// No es decoración: es el sitio donde viven los ajustes que se cambian A MENUDO
// y siempre en el contexto del archivo abierto (indentación, fin de línea). Los
// de Ajustes son los que se tocan una vez.
//
//   izquierda: conexión · rama de git · problemas · servidor de lenguaje
//   derecha:   posición · indentación · fin de línea · lenguaje · modelo · consumo
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useProblemsStore } from '../store/problemsStore';
import { useGitStore } from '../store/gitStore';
import { useLspStore } from '../store/lspStore';
import { serversFor, serverById } from '../lib/lspServers';
import { languageLabel } from '../editor/languages';
import { getAppVersion } from '../lib/tauri';
import { planColor } from '../lib/planColors';
import {
  IconWarn, IconX, IconCheck, IconChart, IconGitBranch, IconRefresh,
} from '../components/Icons';

const STATUS_LABEL = {
  connected: 'Conectado',
  connecting: 'Conectando…',
  disconnected: 'Sin conexión',
};

const LSP_STATE = {
  ready: 'activo',
  starting: 'arrancando…',
  installing: 'instalando…',
  failed: 'error',
};

/** Item de la barra que abre un menú hacia arriba. */
function StatusMenu({ label, title, align = 'right', children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="statusbar__wrap" ref={ref}>
      <button
        className={`statusbar__item ${open ? 'is-open' : ''}`}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div
          className={`statusbar__menu statusbar__menu--${align}`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ checked, onClick, children }) {
  return (
    <button className="statusbar__menu-item" onClick={onClick}>
      <span className="statusbar__menu-check">{checked && <IconCheck size={13} />}</span>
      {children}
    </button>
  );
}

export function StatusBar() {
  const {
    connectionStatus, latency, currentModel, user, workspaceRoot,
    openModal, openBottomPanel, showBottomPanel, openLeftPanel,
    tabSize, setTabSize, insertSpaces, setInsertSpaces,
  } = useAppStore();

  const { tabs, activePath, cursor, setEol } = useEditorStore();
  const diagnostics = useProblemsStore((s) => s.diagnostics);
  const {
    isRepo, branch, changes, hasRemote, ahead, behind,
    refresh: gitRefresh, init: gitInit, sync: gitSync, loading: gitLoading,
  } = useGitStore();
  const lspServers = useLspStore((s) => s.servers);

  const [currentVersion, setCurrentVersion] = useState('');
  useEffect(() => { getAppVersion().then(setCurrentVersion).catch(() => {}); }, []);

  const tab = tabs.find((t) => t.path === activePath) || null;

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warns = diagnostics.length - errors;

  // Servidor de lenguaje del archivo abierto (si su lenguaje tiene uno).
  const server = tab ? serversFor(tab.name)[0] : null;
  const serverState = server ? lspServers[server.id]?.state : null;

  // Un servidor instalándose o arrancando en segundo plano (puede no ser el del
  // archivo actual): merece aviso, porque tarda.
  const busy = Object.entries(lspServers).find(
    ([, s]) => s.state === 'installing' || s.state === 'starting',
  );

  const planName = user?.plan_name || 'Gratuito';

  return (
    <footer className="statusbar">
      {/* ── Izquierda ─────────────────────────────────────────────── */}

      <span className="statusbar__item" title="Estado de la conexión con el servidor">
        <span className={`statusbar__dot is-${connectionStatus}`} />
        {STATUS_LABEL[connectionStatus] || connectionStatus}
        {connectionStatus === 'connected' && latency > 0 && ` · ${latency} ms`}
      </span>

      {/* En una carpeta que no es repo, lo útil no es esconder Git: es ofrecer
          crear el repositorio ahí mismo. */}
      {workspaceRoot && isRepo === false && (
        <button
          className="statusbar__item"
          onClick={gitInit}
          title="Crear un repositorio Git en esta carpeta (git init)"
          disabled={gitLoading}
        >
          <IconGitBranch size={13} />
          Inicializar repositorio
        </button>
      )}

      {isRepo && branch && (
        <span className="statusbar__group">
          <button
            className="statusbar__item"
            onClick={() => openLeftPanel('git')}
            title={`Rama actual${changes.length ? ` · ${changes.length} cambios sin confirmar` : ' · sin cambios'}`}
          >
            <IconGitBranch size={13} />
            {branch}{changes.length > 0 && '*'}
          </button>
          <button
            className="statusbar__item"
            onClick={hasRemote
              ? () => { showBottomPanel('terminal'); gitSync(); } // el push puede pedir credenciales
              : gitRefresh}
            title={hasRemote
              ? 'Sincronizar con el remoto (pull + push)'
              : 'Actualizar el estado de Git · sin remoto configurado'}
            disabled={gitLoading}
          >
            <IconRefresh size={13} />
            {hasRemote && (behind > 0 || ahead > 0) && (
              <>{behind > 0 && `↓${behind}`}{ahead > 0 && `↑${ahead}`}</>
            )}
          </button>
        </span>
      )}

      <button
        className="statusbar__item"
        onClick={() => openBottomPanel('problems')}
        title="Problemas del archivo activo"
      >
        <IconX size={13} /> {errors}
        <span className="statusbar__gap" />
        <IconWarn size={13} /> {warns}
      </button>

      {busy && (
        <button
          className="statusbar__item"
          onClick={() => openModal('settings', 'lsp')}
          title="Servidor de lenguaje"
        >
          {busy[1].state === 'installing' ? 'Instalando' : 'Arrancando'}{' '}
          {serverById(busy[0])?.label || busy[0]}…
        </button>
      )}

      <span className="statusbar__spacer" />

      {/* ── Derecha (contexto del archivo) ────────────────────────── */}

      {tab && (
        <>
          <span className="statusbar__item" title="Posición del cursor">
            Ln {cursor.line}, Col {cursor.col}
            {cursor.selected > 0 && ` (${cursor.selected} sel.)`}
          </span>

          <StatusMenu
            label={insertSpaces ? `Espacios: ${tabSize}` : `Tabulación: ${tabSize}`}
            title="Indentación del editor"
          >
            <span className="statusbar__menu-title">Indentar con</span>
            <MenuItem checked={insertSpaces} onClick={() => setInsertSpaces(true)}>
              Espacios
            </MenuItem>
            <MenuItem checked={!insertSpaces} onClick={() => setInsertSpaces(false)}>
              Tabulaciones
            </MenuItem>

            <span className="statusbar__menu-sep" />
            <span className="statusbar__menu-title">Tamaño</span>
            {[2, 4, 8].map((n) => (
              <MenuItem key={n} checked={tabSize === n} onClick={() => setTabSize(n)}>
                {n} espacios
              </MenuItem>
            ))}
          </StatusMenu>

          <StatusMenu
            label={tab.eol === '\r\n' ? 'CRLF' : 'LF'}
            title="Fin de línea del archivo"
          >
            <span className="statusbar__menu-title">Fin de línea</span>
            <MenuItem checked={tab.eol !== '\r\n'} onClick={() => setEol(tab.path, '\n')}>
              LF <span className="statusbar__menu-hint">Unix</span>
            </MenuItem>
            <MenuItem checked={tab.eol === '\r\n'} onClick={() => setEol(tab.path, '\r\n')}>
              CRLF <span className="statusbar__menu-hint">Windows</span>
            </MenuItem>
          </StatusMenu>

          <span className="statusbar__item" title="Lenguaje detectado">
            {languageLabel(tab.name) || 'texto plano'}
          </span>

          {server && (
            <button
              className="statusbar__item"
              onClick={() => openModal('settings', 'lsp')}
              title={`Servidor de lenguaje · ${LSP_STATE[serverState] || 'no instalado'}`}
            >
              <span className={`statusbar__dot is-lsp-${serverState || 'missing'}`} />
              {server.label.split(' ')[0]}
            </button>
          )}
        </>
      )}

      {currentModel && (
        <span className="statusbar__item" title="Modelo de IA activo">
          {currentModel}
        </span>
      )}

      <button
        className="statusbar__item"
        onClick={() => openModal('metrics')}
        title="Consumo del plan (mensajes y tokens)"
      >
        <IconChart size={13} />
        Consumo
        <span className="statusbar__plan" style={{ color: planColor(user?.plan_id || 'free') }}>
          {planName}
        </span>
      </button>

      {currentVersion && (
        <span className="statusbar__item statusbar__version" title="Versión de la app">
          v{currentVersion}
        </span>
      )}
    </footer>
  );
}
