import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { useConnection } from './hooks/useConnection';
import { AuthScreen } from './sections/Auth/AuthScreen';
import { AppShell } from './layout/AppShell';

export default function App() {
  useConnection();

  const { hydrated, hydrate, apiKey } = useAppStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

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
  if (!apiKey) {
    return <AuthScreen />;
  }

  return <AppShell />;
}
