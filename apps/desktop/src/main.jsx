import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/editor.css";
import "./styles/terminal.css";
import "./styles/chat.css";
import "./styles/views.css";
import "./styles/studio.css";
import "./styles/agent.css";
import "./styles/settings.css";
import "./styles/orch.css";
import "./styles/mascota.css";
import "./styles/ide.css";
import { initUiScale } from "./lib/uiScale";
import { initFrameSize } from "./lib/frameSize";
import { useCodexTermStore } from "./orch/codexterm/codexTermStore";

async function start() {
  // Fuera de Tauri (navegador en `npm run dev`) se simula la API nativa.
  if (import.meta.env.DEV && !window.__TAURI_INTERNALS__) await import("./dev/tauriMock");
  // Solo la ventana del IDE: Team y el aviso de la mascota no llevan este rediseño.
  document.documentElement.dataset.ui = "ide";
  initUiScale();
  initFrameSize();
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  // Pestañas de terminal de Codex que sigan vivas en el host (arranque o recarga de la webview).
  useCodexTermStore.getState().rehydrate().catch(() => {});
}

start();
