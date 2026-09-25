import { useEffect, useState } from 'react';
import { useAppStore } from './store/appStore';
import { useConnection } from './hooks/useConnection';
import { AuthScreen } from './sections/Auth/AuthScreen';
import { AppShell } from './layout/AppShell';
import { TitleBar } from './layout/TitleBar';
import { Onboarding, ONBOARDED_KEY } from './modes/Onboarding';

export default function App() {
  useConnection();

  const { hydrated, hydrate, apiKey } = useAppStore();
  // Solo instalaciones nuevas: quien ya tenía una carpeta abierta no lo ve.
  const [onboarding, setOnboarding] = useState(() => {
    try { return !localStorage.getItem(ONBOARDED_KEY) && !localStorage.getItem('lixbon_workspace_root'); } catch { return false; }
  });

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // La ventana no tiene decoraciones del SO: la TitleBar propia va siempre,
  // en modo minimal (solo logo + controles) hasta que haya sesión.
  const renderBody = () => {
    // Cargando configuración persistida (plugin-store es async)
    if (!hydrated) {
      return (
        <div className="app-loading">
          <span className="brand app-loading__logo">LIXBON</span>
          <div className="app-loading__bar"><span /></div>
        </div>
      );
    }
    // Sin API key: pantalla de entrada (login o pegar key)
    if (!apiKey) return <AuthScreen />;
    if (onboarding) return <Onboarding onDone={() => setOnboarding(false)} />;
    return <AppShell />;
  };

  return (
    <div className="app-frame">
      <TitleBar minimal={!hydrated || !apiKey || onboarding} />
      <div className="app-frame__body">{renderBody()}</div>
    </div>
  );
}
