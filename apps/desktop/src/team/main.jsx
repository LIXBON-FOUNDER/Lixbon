// main.jsx — entrada de la ventana de Lixbon Team (team.html).
import React from 'react';
import ReactDOM from 'react-dom/client';
import { TeamApp } from './TeamApp';
import { ErrorBoundary } from '../components/ErrorBoundary';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '../styles/base.css';
import '../styles/shell.css';
import '../styles/studio.css';
import './styles/team.css';
import './styles/team-window.css';

async function start() {
  if (import.meta.env.DEV && !window.__TAURI_INTERNALS__) await import('../dev/tauriMock');
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary>
        <TeamApp />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

start();
