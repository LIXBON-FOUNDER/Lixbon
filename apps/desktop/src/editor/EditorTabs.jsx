// EditorTabs.jsx — fila de pestañas del editor (punto de dirty + cerrar).
// Clic medio o botón X cierra; clic derecho abre un menú (cerrar otras / a la
// derecha / guardadas, copiar ruta, revelar en el explorador).
import { useState, useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { revealInOs } from '../lib/tauri';
import { IconX } from '../components/Icons';

export function EditorTabs() {
  const { tabs, activePath, setActive, closeTab, closeOthers, closeToRight, closeSaved, reorderTabs } =
    useEditorStore();
  const [menu, setMenu] = useState(null); // { x, y, path }
  const [dragOver, setDragOver] = useState(null); // path bajo el arrastre
  const menuRef = useRef(null);

  // Cerrar el menú contextual con clic fuera o Escape
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (tabs.length === 0) return null;

  const openMenu = (e, path) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: e.clientY, path });
  };

  const menuItems = () => {
    if (!menu) return [];
    const { path } = menu;
    const idx = tabs.findIndex((t) => t.path === path);
    const hasRight = idx >= 0 && idx < tabs.length - 1;
    return [
      { label: 'Cerrar', run: () => closeTab(path) },
      { label: 'Cerrar otras', run: () => closeOthers(path), disabled: tabs.length < 2 },
      { label: 'Cerrar a la derecha', run: () => closeToRight(path), disabled: !hasRight },
      { label: 'Cerrar guardadas', run: () => closeSaved() },
      { sep: true },
      { label: 'Copiar ruta', run: () => navigator.clipboard.writeText(path).catch(() => {}) },
      { label: 'Revelar en el explorador', run: () => revealInOs(path).catch(() => {}) },
    ];
  };

  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          role="tab"
          aria-selected={tab.path === activePath}
          className={`editor-tab ${tab.path === activePath ? 'is-active' : ''} ${dragOver === tab.path ? 'is-dragover' : ''}`}
          title={tab.path}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/lixbon-tab', tab.path);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('text/lixbon-tab')) {
              e.preventDefault();
              setDragOver(tab.path);
            }
          }}
          onDragLeave={() => setDragOver((p) => (p === tab.path ? null : p))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const src = e.dataTransfer.getData('text/lixbon-tab');
            if (src && src !== tab.path) reorderTabs(src, tab.path);
          }}
          onDragEnd={() => setDragOver(null)}
          onClick={() => setActive(tab.path)}
          onAuxClick={(e) => { if (e.button === 1) closeTab(tab.path); }}
          onContextMenu={(e) => openMenu(e, tab.path)}
        >
          <span className="editor-tab__name">{tab.name}</span>
          {tab.dirty && <span className="editor-tab__dirty" title="Cambios sin guardar" />}
          <button
            className="editor-tab__close"
            title="Cerrar (Ctrl+W)"
            onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
          >
            <IconX size={13} />
          </button>
        </div>
      ))}

      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menuItems().map((item, i) =>
            item.sep ? (
              <div key={i} className="ctx-menu__sep" />
            ) : (
              <button
                key={i}
                className="ctx-menu__item"
                disabled={item.disabled}
                onClick={() => { setMenu(null); item.run(); }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
