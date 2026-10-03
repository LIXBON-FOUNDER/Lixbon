// main.jsx — entrada del aviso flotante de la mascota (mascota.html), la
// ventana que src-tauri/src/mascota.rs abre sobre las demás apps.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Flotante } from './Flotante';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '../styles/base.css';
import '../styles/mascota.css';
import './flotante.css';

// En macOS la ventana no es transparente (haría falta la API privada): ahí
// el aviso se pinta como una tarjeta con fondo.
if (/Mac/.test(navigator.userAgent)) document.body.classList.add('is-opaca');

async function start() {
  // Fuera de Tauri (npm run dev) se simula la API nativa, como en el IDE.
  if (import.meta.env.DEV && !window.__TAURI_INTERNALS__) await import('../dev/tauriMock');
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <Flotante />
    </React.StrictMode>,
  );
}

start();
