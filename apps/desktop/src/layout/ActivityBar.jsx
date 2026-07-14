// ActivityBar.jsx — barra fina de navegación del IDE (izquierda).
// Solo vistas del panel lateral (+ terminal). Problemas vive en el dock inferior
// y Consumo en la barra de estado y el menú de cuenta: duplicarlos aquí solo
// añadía iconos que no llevan a ninguna parte nueva.
// El toggle del chat vive en la TitleBar (a la derecha, junto al panel que abre).
import { useAppStore } from '../store/appStore';
import {
  IconPanel, IconSearch, IconGear, IconTerminal, IconGitBranch, IconPuzzle, IconList,
} from '../components/Icons';

export function ActivityBar() {
  const {
    panels, leftView, openLeftPanel,
    bottomView, openBottomPanel,
    modalView, openModal, closeModal,
  } = useAppStore();

  const leftActive = (view) => panels.explorer && leftView === view;
  const bottomActive = (view) => panels.terminal && bottomView === view;
  // Ajustes y Consumo son ventanas flotantes: el botón las abre y las cierra.
  const toggleModal = (view) => (modalView === view ? closeModal() : openModal(view));

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
        className={`activitybar__btn ${leftActive('outline') ? 'is-active' : ''}`}
        onClick={() => openLeftPanel('outline')}
        title="Esquema (símbolos del archivo)"
      >
        <IconList size={19} />
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
        className={`activitybar__btn ${bottomActive('terminal') ? 'is-active' : ''}`}
        onClick={() => openBottomPanel('terminal')}
        title="Terminal (Ctrl+`)"
      >
        <IconTerminal size={19} />
      </button>

      <div className="activitybar__spacer" />

      <button
        className={`activitybar__btn ${modalView === 'settings' ? 'is-active' : ''}`}
        onClick={() => toggleModal('settings')}
        title="Ajustes"
      >
        <IconGear size={19} />
      </button>
    </nav>
  );
}
