// Sidebar.jsx — panel único de Lixbon: logo + rama activa arriba, nav con
// etiquetas (Chat/Archivos/Git y GitHub/Extensiones), el contenido de la vista
// activa debajo, y la cuenta al fondo. Se pliega con la barrita (`.handle`) que
// crece al pasar el cursor y alterna con un clic — nunca se arrastra ni se
// redimensiona, a diferencia del panel lateral anterior.
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { AccountMenu } from './AccountMenu';
import { FileTree } from '../sections/Workspace/FileTree';
import { SourceControl } from '../sections/SourceControl/SourceControl';
import { ExtensionsPanel } from '../sections/Extensions/ExtensionsPanel';
import { HistoryList } from '../chat/HistoryList';
import {
  IconChat, IconFolder, IconGitBranch, IconPuzzle, IconTerminal,
} from '../components/Icons';

const NAV = [
  { id: 'chat', label: 'Chat', Icon: IconChat },
  { id: 'explorer', label: 'Archivos', Icon: IconFolder },
  { id: 'git', label: 'Git y GitHub', Icon: IconGitBranch },
  { id: 'extensions', label: 'Extensiones', Icon: IconPuzzle },
];

const CONN_LABEL = { connecting: 'Conectando…', disconnected: 'Sin conexión con el servidor' };

export function Sidebar() {
  const {
    sidebarOpen, leftView, selectNav, toggleSidebar, panels, toggleTerminal,
    workspaceRoot, connectionStatus,
  } = useAppStore();
  const {
    isRepo, branch, changes, hasRemote, ahead, behind,
    refresh: gitRefresh, sync: gitSync, init: gitInit, loading: gitLoading,
  } = useGitStore();

  const branchStatus = () => {
    // La conexión con el gateway manda: sin ella nada de esto es fiable.
    if (connectionStatus !== 'connected') {
      return { label: workspaceRoot ? branch || 'lixbon' : 'Lixbon', sub: CONN_LABEL[connectionStatus] || connectionStatus, action: null, dot: 'bad' };
    }
    if (!workspaceRoot) return { label: 'Sin carpeta abierta', sub: '', action: null, dot: null };
    if (isRepo === false) return { label: 'Inicializar Git', sub: 'sin repositorio', action: gitInit, dot: null };
    if (!branch) return { label: 'lixbon', sub: '…', action: gitRefresh, dot: null };
    const sub = hasRemote && (ahead > 0 || behind > 0)
      ? `${behind > 0 ? `↓${behind} ` : ''}${ahead > 0 ? `↑${ahead}` : ''}`.trim()
      : branch;
    return {
      label: branch,
      sub: hasRemote && (ahead > 0 || behind > 0) ? sub : (changes.length > 0 ? `${changes.length} cambios` : 'al día'),
      action: hasRemote ? gitSync : gitRefresh,
      dot: changes.length > 0 ? 'warn' : 'good',
    };
  };
  const bs = branchStatus();

  return (
    <>
      <aside className={`sidebar panel ${sidebarOpen ? '' : 'is-collapsed'}`}>
        <div className="sidebar__brand">
          <img src="/favicon.svg" className="sidebar__logo" alt="" draggable={false} />
          <span className="sidebar__brandname">LIXBON</span>
        </div>

        {(workspaceRoot || connectionStatus !== 'connected') && (
          <div className="sidebar__branch">
            <button className="branchcard" onClick={bs.action || undefined} disabled={gitLoading || !bs.action} title="Sincronizar / actualizar el estado de Git">
              <IconGitBranch size={14} className="branchcard__icon" />
              <div className="branchcard__text">
                <span className="branchcard__name">{bs.label}</span>
                {bs.sub && <span className="branchcard__sub">{bs.sub}</span>}
              </div>
              {bs.dot && <span className={`branchcard__dot branchcard__dot--${bs.dot}`} />}
            </button>
          </div>
        )}

        <nav className="sidebar__nav">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`navitem ${leftView === id ? 'is-active' : ''}`}
              onClick={() => selectNav(id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar__section">
          {leftView === 'chat' && <HistoryList />}
          {leftView === 'explorer' && <FileTree />}
          {leftView === 'git' && <SourceControl />}
          {leftView === 'extensions' && <ExtensionsPanel />}
        </div>

        {leftView === 'chat' && (
          <div className="sidebar__terminal">
            <button className="subitem" onClick={toggleTerminal}>
              <IconTerminal size={15} /> Terminal{panels.terminal ? ' (abierta)' : ''}
            </button>
          </div>
        )}

        <div className="sidebar__foot">
          <AccountMenu />
        </div>
      </aside>

      <button className="handle" onClick={toggleSidebar} title={sidebarOpen ? 'Plegar panel' : 'Desplegar panel'}>
        <span className="handle__bar" />
      </button>
    </>
  );
}
