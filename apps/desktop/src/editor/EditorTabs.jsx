// EditorTabs.jsx — fila de pestañas del editor (punto de dirty + cerrar).
import { useEditorStore } from '../store/editorStore';
import { IconX } from '../components/Icons';

export function EditorTabs() {
  const { tabs, activePath, setActive, closeTab } = useEditorStore();

  if (tabs.length === 0) return null;

  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          role="tab"
          aria-selected={tab.path === activePath}
          className={`editor-tab ${tab.path === activePath ? 'is-active' : ''}`}
          title={tab.path}
          onClick={() => setActive(tab.path)}
          onAuxClick={(e) => { if (e.button === 1) closeTab(tab.path); }}
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
    </div>
  );
}
