// RunControls.jsx — botones Run/Build. Detecta el tipo de proyecto en el root del
// workspace y ejecuta el comando en el terminal integrado (reutiliza el PTY).
import { useEffect, useState } from 'react';
import { getWorkspaceRoot, readDir } from '../lib/tauri';
import { detectRunConfig } from '../lib/runConfigs';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { IconPlay, IconHammer } from '../components/Icons';

export function RunControls() {
  const [config, setConfig] = useState(null);
  const showBottomPanel = useAppStore((s) => s.showBottomPanel);
  const runCommand = useTerminalStore((s) => s.runCommand);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const root = await getWorkspaceRoot();
        if (!root) return;
        const entries = await readDir(root);
        if (!cancelled) setConfig(detectRunConfig(entries));
      } catch { /* sin workspace todavía */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
