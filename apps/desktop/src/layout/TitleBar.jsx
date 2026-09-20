// TitleBar.jsx — barra de ventana propia (decorations: false), reducida al
// mínimo: logo solo en modo minimal (pantalla de auth, sin sidebar todavía);
// el resto de la app vive con solo tema claro/oscuro, Lixbon Team y los
// controles de ventana — logo, rama y estado de Git viven en el sidebar.
import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../store/appStore';
import { useRemoteStore } from '../store/remoteStore';
import { TeamButton } from './TeamButton';
import { useTheme } from '../lib/theme';
import {
  IconWinMin, IconWinMax, IconWinRestore, IconX, IconSun, IconMoon,
} from '../components/Icons';

export function TitleBar({ minimal = false }) {
  const openModal = useAppStore((s) => s.openModal);
  const remoteActive = useRemoteStore((s) => s.active);
  const [theme, setThemeMode] = useTheme();
  const [maximized, setMaximized] = useState(false);

  const win = getCurrentWindow();

  useEffect(() => {
    let unlisten = null;
    let alive = true;
    win.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => {});
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { alive = false; if (unlisten) unlisten(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header className="titlebar">
      {minimal && (
        <div className="titlebar__left">
          <img src="/favicon.svg" className="titlebar__logo" alt="" draggable={false} />
          <span className="titlebar__brand" data-tauri-drag-region>LIXBON</span>
        </div>
      )}

      <div className="titlebar__drag" data-tauri-drag-region />

      <div className="titlebar__right">
        {!minimal && remoteActive && (
          <button className="remotebtn" onClick={() => openModal('remote')} title="Sesión de control remoto activa">
            <span className="remotebtn__dot" />
          </button>
        )}
        {!minimal && (
          <button
            className="theme-toggle"
            onClick={() => setThemeMode(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            <span className={`theme-toggle__thumb ${theme === 'dark' ? 'is-dark' : ''}`}>
              {theme === 'dark' ? <IconMoon size={12} /> : <IconSun size={12} />}
            </span>
          </button>
        )}
        {!minimal && <TeamButton />}
        <div className="titlebar__controls">
          <button className="titlebar__win-btn" onClick={() => win.minimize()} title="Minimizar">
            <IconWinMin size={16} />
          </button>
          <button
            className="titlebar__win-btn"
            onClick={() => win.toggleMaximize()}
            title={maximized ? 'Restaurar' : 'Maximizar'}
          >
            {maximized ? <IconWinRestore size={15} /> : <IconWinMax size={14} />}
          </button>
          <button
            className="titlebar__win-btn titlebar__win-btn--close"
            onClick={() => win.close()}
            title="Cerrar"
          >
            <IconX size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
