// WindowControls.jsx — minimizar, maximizar y cerrar; lo usan el IDE y la ventana de Team.
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconMinimize, IconMaximize, IconRestore, IconClose } from '../components/IdeIcons';

// `flat`: tres botones con su glifo siempre visible (el IDE). Sin él, los tres
// puntos que se vuelven glifos al acercarse (la ventana de Team).
export function WindowControls({ flat = false }) {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten = null;
    let alive = true;
    const sync = () => win.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => {});
    sync();
    win.onResized(sync).then((u) => { unlisten = u; }).catch(() => {});
    return () => { alive = false; if (unlisten) unlisten(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (flat) {
    return (
      <div className="wctl">
        <button className="wctl__btn" onClick={() => win.minimize()} aria-label="Minimizar" title="Minimizar"><IconMinimize size={18} /></button>
        <button className="wctl__btn" onClick={() => win.toggleMaximize()} aria-label={maximized ? 'Restaurar' : 'Maximizar'} title={maximized ? 'Restaurar' : 'Maximizar'}>
          {maximized ? <IconRestore size={18} /> : <IconMaximize size={18} />}
        </button>
        <button className="wctl__btn wctl__btn--close" onClick={() => win.close()} aria-label="Cerrar" title="Cerrar"><IconClose size={18} /></button>
      </div>
    );
  }

  return (
    <div className="winctl">
      <button className="winctl__btn" onClick={() => win.minimize()} aria-label="Minimizar">
        <span className="winctl__dot" />
        <svg className="winctl__glyph" viewBox="0 0 12 12"><path d="M2.5 8.5h7" /></svg>
      </button>
      <button className="winctl__btn" onClick={() => win.toggleMaximize()} aria-label={maximized ? 'Restaurar' : 'Maximizar'}>
        <span className="winctl__dot" />
        <svg className="winctl__glyph" viewBox="0 0 12 12">
          {maximized
            ? <path d="M5.5 2.5v3h-3M6.5 9.5v-3h3M5.5 5.5l-3-3M6.5 6.5l3 3" />
            : <path d="M2.5 5.5v-3h3M9.5 6.5v3h-3M2.5 2.5l3 3M9.5 9.5l-3-3" />}
        </svg>
      </button>
      <button className="winctl__btn winctl__btn--close" onClick={() => win.close()} aria-label="Cerrar">
        <span className="winctl__dot" />
        <svg className="winctl__glyph" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3 3 9" /></svg>
      </button>
    </div>
  );
}
