// ActivityBar.jsx — barra fina de navegación del IDE (izquierda).
// El toggle del chat vive en la TitleBar (a la derecha, junto al panel que abre).
import { useAppStore } from '../store/appStore';
import {
  IconPanel, IconSearch, IconChart, IconGear, IconTerminal, IconGitBranch, IconPuzzle,
} from '../components/Icons';

export function ActivityBar() {
  const { panels, togglePanel, centerView, setCenterView, leftView, openLeftPanel } = useAppStore();

  // Métricas y Ajustes ocupan el centro; clic de nuevo vuelve al editor
  const toggleCenter = (view) => {
    setCenterView(centerView === view ? 'editor' : view);
  };

  const leftActive = (view) => panels.explorer && leftView === view;

  return (
    <nav className="activitybar">
      <button
        className={`activitybar__btn ${leftActive('explorer') ? 'is-active' : ''}`}
        onClick={() => openLeftPanel('explorer')}
        title="Explorador"
      >
        <IconPanel size={19} />
      </button>

      <button
        className={`activitybar__btn ${leftActive('search') ? 'is-active' : ''}`}
        onClick={() => openLeftPanel('search')}
        title="Buscar en archivos (Ctrl+Mayús+F)"
      >
        <IconSearch size={19} />
      </button>

      <button
        className={`activitybar__btn ${leftActive('git') ? 'is-active' : ''}`}
        onClick={() => openLeftPanel('git')}
        title="Control de código (Git)"
      >
        <IconGitBranch size={19} />
      </button>

      <button
        className={`activitybar__btn ${leftActive('extensions') ? 'is-active' : ''}`}
        onClick={() => openLeftPanel('extensions')}
        title="Extensiones (temas de VSCode)"
      >
        <IconPuzzle size={19} />
      </button>

      <button
        className={`activitybar__btn ${panels.terminal ? 'is-active' : ''}`}
        onClick={() => togglePanel('terminal')}
        title="Terminal (Ctrl+`)"
      >
        <IconTerminal size={19} />
      </button>

      <div className="activitybar__spacer" />

      <button
        className={`activitybar__btn ${centerView === 'metrics' ? 'is-active' : ''}`}
        onClick={() => toggleCenter('metrics')}
        title="Métricas de uso"
      >
        <IconChart size={19} />
      </button>

      <button
        className={`activitybar__btn ${centerView === 'settings' ? 'is-active' : ''}`}
        onClick={() => toggleCenter('settings')}
        title="Ajustes"
      >
        <IconGear size={19} />
      </button>
    </nav>
  );
}
