import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { useConnection } from './hooks/useConnection';
import { AuthScreen } from './sections/Auth/AuthScreen';
import { AppShell } from './layout/AppShell';
import { TitleBar } from './layout/TitleBar';

export default function App() {
  useConnection();

  const { hydrated, hydrate, apiKey } = useAppStore();

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
    return <AppShell />;
  };

  return (
    <div className="app-frame">
      <TitleBar minimal={!hydrated || !apiKey} />
      <div className="app-frame__body">{renderBody()}</div>
    </div>
  );
}
