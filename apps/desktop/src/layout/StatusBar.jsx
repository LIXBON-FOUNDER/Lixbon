// StatusBar.jsx — barra de estado inferior: conexión, modelo, plan y versión.
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { getAppVersion } from '../lib/tauri';
import { planColor } from '../lib/planColors';

const STATUS_LABEL = {
  connected: 'Conectado',
  connecting: 'Conectando…',
  disconnected: 'Sin conexión',
};

export function StatusBar() {
  const { connectionStatus, latency, currentModel, user, setCenterView } = useAppStore();
  const [currentVersion, setCurrentVersion] = useState('');

  useEffect(() => {
    getAppVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const planName = user?.plan_name || 'Gratuito';
  const planId = user?.plan_id || 'free';

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title="Estado de la conexión con el servidor">
        <span className={`statusbar__dot is-${connectionStatus}`} />
        {STATUS_LABEL[connectionStatus] || connectionStatus}
        {connectionStatus === 'connected' && latency > 0 && ` · ${latency} ms`}
      </span>

      {currentModel && (
        <span className="statusbar__item" title="Modelo activo">
          {currentModel}
        </span>
      )}

      <span className="statusbar__spacer" />

      <button
        className="statusbar__item statusbar__plan"
        style={{ color: planColor(planId) }}
        onClick={() => setCenterView('metrics')}
        title="Plan actual — clic para ver tu consumo"
      >
        Plan {planName}
      </button>

      {currentVersion && (
        <span className="statusbar__item" title="Versión de la app">
          v{currentVersion}
        </span>
      )}
    </footer>
  );
}
