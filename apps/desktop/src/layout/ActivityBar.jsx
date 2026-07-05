// ActivityBar.jsx — barra fina de navegación del IDE (izquierda).
import { useAppStore } from '../store/appStore';
import { IconPanel, IconChat, IconChart, IconGear } from '../components/Icons';

export function ActivityBar() {
  const { panels, togglePanel, centerView, setCenterView } = useAppStore();

  // Métricas y Ajustes ocupan el centro; clic de nuevo vuelve al editor
  const toggleCenter = (view) => {
    setCenterView(centerView === view ? 'editor' : view);
  };

  return (
    <nav className="activitybar">
      <span className="activitybar__brand" title="FOLAX">F</span>

      <button
        className={`activitybar__btn ${panels.explorer ? 'is-active' : ''}`}
        onClick={() => togglePanel('explorer')}
        title="Explorador"
      >
        <IconPanel size={19} />
      </button>

      <button
        className={`activitybar__btn ${panels.chat ? 'is-active' : ''}`}
        onClick={() => togglePanel('chat')}
        title="Chat"
      >
        <IconChat size={19} />
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
