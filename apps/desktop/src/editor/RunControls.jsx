// RunControls.jsx — botones Run/Build. Detecta el tipo de proyecto en el root del
// workspace y ejecuta el comando en el terminal integrado (reutiliza el PTY).
import { useEffect, useState } from 'react';
import { readDir } from '../lib/tauri';
import { detectRunConfig } from '../lib/runConfigs';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { IconPlay, IconHammer } from '../components/Icons';

export function RunControls() {
  const [config, setConfig] = useState(null);
  const showBottomPanel = useAppStore((s) => s.showBottomPanel);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const runCommand = useTerminalStore((s) => s.runCommand);

  // Re-detecta al cambiar de carpeta (el arranque restaura el workspace en
  // ASYNC: con la detección única de antes, los botones no aparecían nunca en
  // un arranque frío) y cuando cambia el disco (p. ej. el agente acaba de
  // crear el package.json), con un pequeño debounce.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const detect = async () => {
      if (!workspaceRoot) { setConfig(null); return; }
      try {
        const entries = await readDir(workspaceRoot);
        if (!cancelled) setConfig(detectRunConfig(entries));
      } catch {
        if (!cancelled) setConfig(null);
      }
    };
    detect();
    const onFsChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(detect, 800);
    };
    window.addEventListener('lixbon:fs-changed', onFsChanged);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('lixbon:fs-changed', onFsChanged);
    };
  }, [workspaceRoot]);

  const run = (cmd) => {
    if (!cmd) return;
    showBottomPanel('terminal'); // el comando escribe en el PTY: hay que verlo
    runCommand(cmd);
  };

  if (!config) return null;

  return (
    <div className="run-controls">
      <span className="run-controls__label" title="Tipo de proyecto detectado">
        {config.label}
      </span>
      {config.run && (
        <button
          className="run-controls__btn run-controls__btn--run"
          onClick={() => run(config.run)}
          title={`Ejecutar: ${config.run}`}
        >
          <IconPlay size={13} /> Run
        </button>
      )}
      {config.build && (
        <button
          className="run-controls__btn"
          onClick={() => run(config.build)}
          title={`Compilar: ${config.build}`}
        >
          <IconHammer size={13} /> Build
        </button>
      )}
    </div>
  );
}
