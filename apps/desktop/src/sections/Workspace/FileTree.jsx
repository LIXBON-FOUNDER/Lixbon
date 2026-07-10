// FileTree.jsx — explorador de archivos del workspace (panel izquierdo).
// Clic en un archivo → abre pestaña en el editor. Clic derecho → menú
// contextual (nuevo, renombrar, duplicar, copiar ruta, revelar, eliminar).
// La carpeta raíz vive en appStore.workspaceRoot (la fija openWorkspace).
import { useState, useEffect, useCallback, useRef } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  readDir, createNewEntry, renameEntry, deleteEntry, duplicateEntry,
  revealInOs, pickDirectory,
} from '../../lib/tauri';
import { useEditorStore } from '../../store/editorStore';
import { useAppStore } from '../../store/appStore';
import {
  IconFolder,
  IconFolderOpen,
  IconFile,
  IconFileCode,
  IconFilePlus,
  IconFolderPlus,
  IconRefresh,
  IconChevron,
  IconChevronRight,
} from '../../components/Icons';

const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'css', 'scss', 'html', 'json',
  'md', 'toml', 'yml', 'yaml', 'sh', 'sql', 'vue', 'svelte', 'c', 'cpp', 'h', 'java',
]);

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return CODE_EXTS.has(ext) ? <IconFileCode size={15} /> : <IconFile size={15} />;
}

function baseName(path) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export function FileTree() {
  const { openFile, activePath } = useEditorStore();
  const rootPath = useAppStore((s) => s.workspaceRoot);
  const openWorkspace = useAppStore((s) => s.openWorkspace);

  const [treeData, setTreeData] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState({});
  const [dirChildren, setDirChildren] = useState({});
  const [error, setError] = useState('');

  // Creación inline de archivos/carpetas
  const [newItemParent, setNewItemParent] = useState(null);
  const [newItemType, setNewItemType] = useState(null); // 'file' | 'dir'
  const [newItemName, setNewItemName] = useState('');

  // Renombrado inline: { path, parent, name }
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  // Menú contextual: { x, y, entry, parent } (entry=null → área raíz)
  const [ctxMenu, setCtxMenu] = useState(null);
  const menuRef = useRef(null);

  const loadRoot = useCallback(async () => {
    if (!rootPath) return;
    try {
      setTreeData(await readDir(rootPath));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, [rootPath]);

  // Cambio de carpeta de trabajo (o arranque): recargar el árbol desde cero
  useEffect(() => {
    setExpandedDirs({});
    setDirChildren({});
    setTreeData([]);
    loadRoot();
  }, [rootPath, loadRoot]);

  // Cerrar el menú contextual con clic fuera o Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [ctxMenu]);

  const handleOpenFolder = async () => {
    try {
      const selected = await pickDirectory({ title: 'Abrir carpeta de trabajo' });
      if (selected) await openWorkspace(selected);
    } catch (e) {
      setError(String(e));
    }
  };

  const refreshDirectory = async (path) => {
    try {
      const entries = await readDir(path);
      setDirChildren((prev) => ({ ...prev, [path]: entries }));
    } catch (e) {
      console.error('[filetree] Error leyendo carpeta:', e);
    }
  };

  const refreshParent = async (parent) => {
    if (!parent || parent === rootPath) await loadRoot();
    else await refreshDirectory(parent);
  };

  const toggleDirectory = async (path) => {
    const isExpanded = !!expandedDirs[path];
    setExpandedDirs((prev) => ({ ...prev, [path]: !isExpanded }));
    if (!isExpanded) await refreshDirectory(path);
  };

  const handleSelectFile = async (path, name) => {
    try {
      await openFile(path, name);
    } catch (e) {
      alert('Error abriendo el archivo: ' + e);
    }
  };

  const handleCreateEntry = async (e) => {
    e.preventDefault();
    if (!newItemName.trim()) return;
    const parent = newItemParent || rootPath;
    try {
      await createNewEntry(parent, newItemName.trim(), newItemType === 'dir');
      await refreshParent(parent);
    } catch (err) {
      alert('Error creando entrada: ' + err);
    } finally {
      setNewItemParent(null);
      setNewItemType(null);
      setNewItemName('');
    }
  };

  // ── Acciones del menú contextual ─────────────────────────────────────

  const startRename = (entry, parent) => {
    setRenaming({ path: entry.path, parent, name: entry.name });
    setRenameValue(entry.name);
  };

  const handleRenameSubmit = async (e) => {
    e.preventDefault();
    const next = renameValue.trim();
    const current = renaming;
    setRenaming(null);
    if (!current || !next || next === current.name) return;
    try {
      const newPath = await renameEntry(current.path, next);
      useEditorStore.getState().remapPaths(current.path, newPath);
      await refreshParent(current.parent);
    } catch (err) {
      alert('Error renombrando: ' + err);
    }
  };

  const handleDelete = async (entry, parent) => {
    const confirmed = await ask(
      `¿Eliminar ${entry.is_dir ? 'la carpeta' : 'el archivo'} "${entry.name}"? Esta acción no se puede deshacer.`,
      { title: 'lixbon', kind: 'warning', okLabel: 'Eliminar', cancelLabel: 'Cancelar' }
    );
    if (!confirmed) return;
    try {
      await deleteEntry(entry.path);
      useEditorStore.getState().closeUnder(entry.path);
      await refreshParent(parent);
    } catch (err) {
      alert('Error eliminando: ' + err);
    }
  };

  const handleDuplicate = async (entry, parent) => {
    try {
      await duplicateEntry(entry.path);
      await refreshParent(parent);
    } catch (err) {
      alert('Error duplicando: ' + err);
    }
  };

  const copyToClipboard = (text) => navigator.clipboard.writeText(text).catch(() => {});

  const relativePath = (path) => {
    if (path.startsWith(rootPath)) {
      return path.slice(rootPath.length).replace(/^[\\/]+/, '');
    }
    return path;
  };

  const openCtxMenu = (e, entry, parent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: Math.min(e.clientX, window.innerWidth - 240),
      y: Math.min(e.clientY, window.innerHeight - 320),
      entry,
      parent,
    });
  };

  const ctxItems = () => {
    if (!ctxMenu) return [];
    const { entry, parent } = ctxMenu;

    if (!entry) {
      // Área vacía / raíz
      return [
        { label: 'Nuevo archivo', run: () => { setNewItemParent(rootPath); setNewItemType('file'); } },
        { label: 'Nueva carpeta', run: () => { setNewItemParent(rootPath); setNewItemType('dir'); } },
        { sep: true },
        { label: 'Refrescar', run: loadRoot },
        { label: 'Revelar en el explorador', run: () => revealInOs(rootPath).catch(() => {}) },
      ];
    }

    const items = [];
    if (entry.is_dir) {
      items.push(
        { label: 'Nuevo archivo', run: () => { setNewItemParent(entry.path); setNewItemType('file'); setExpandedDirs((p) => ({ ...p, [entry.path]: true })); } },
        { label: 'Nueva carpeta', run: () => { setNewItemParent(entry.path); setNewItemType('dir'); setExpandedDirs((p) => ({ ...p, [entry.path]: true })); } },
        { sep: true },
      );
    } else {
      items.push({ label: 'Abrir', run: () => handleSelectFile(entry.path, entry.name) }, { sep: true });
    }
    items.push(
      { label: 'Renombrar', run: () => startRename(entry, parent) },
      { label: 'Duplicar', run: () => handleDuplicate(entry, parent) },
      { sep: true },
      { label: 'Copiar ruta', run: () => copyToClipboard(entry.path) },
      { label: 'Copiar ruta relativa', run: () => copyToClipboard(relativePath(entry.path)) },
      { label: 'Revelar en el explorador', run: () => revealInOs(entry.path).catch(() => {}) },
      { sep: true },
      { label: 'Eliminar', danger: true, run: () => handleDelete(entry, parent) },
    );
    return items;
  };

  // ── Render ───────────────────────────────────────────────────────────

  const inlineForm = (parentPath, indent) => (
    newItemParent === parentPath && (
      <form onSubmit={handleCreateEntry} className="filetree__inline-form" style={{ paddingLeft: indent }}>
        <input
          className="filetree__inline-input"
          type="text"
          placeholder={newItemType === 'file' ? 'nombre-archivo.ext' : 'nombre-carpeta'}
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          autoFocus
          onBlur={() => setTimeout(() => { setNewItemParent(null); setNewItemType(null); }, 200)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setNewItemParent(null); setNewItemType(null); } }}
          spellCheck={false}
        />
      </form>
    )
  );

  const renameForm = (indent) => (
    <form onSubmit={handleRenameSubmit} className="filetree__inline-form" style={{ paddingLeft: indent }}>
      <input
        className="filetree__inline-input"
        type="text"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        autoFocus
        onFocus={(e) => {
          // Selecciona el nombre sin la extensión (como VSCode)
          const dot = e.target.value.lastIndexOf('.');
          e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
        }}
        onBlur={() => setRenaming(null)}
        onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
        spellCheck={false}
      />
    </form>
  );

  const renderEntries = (entries, depth = 0, parentPath = rootPath) =>
    entries.map((entry) => {
      const indent = depth * 14 + 10;

      if (renaming?.path === entry.path) {
        return <div key={entry.path}>{renameForm(indent)}</div>;
      }

      if (entry.is_dir) {
        const isExpanded = !!expandedDirs[entry.path];
        const children = dirChildren[entry.path] || [];
        return (
          <div key={entry.path}>
            <div
              className="filetree__node"
              style={{ paddingLeft: indent }}
              onClick={() => toggleDirectory(entry.path)}
              onContextMenu={(e) => openCtxMenu(e, entry, parentPath)}
            >
              {isExpanded ? <IconChevron size={13} open /> : <IconChevronRight size={13} />}
              {isExpanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
              <span className="filetree__label">{entry.name}</span>
              <span className="filetree__node-actions">
                <button
                  title="Nuevo archivo"
                  onClick={(e) => { e.stopPropagation(); setNewItemParent(entry.path); setNewItemType('file'); }}
                >
                  <IconFilePlus size={13} />
                </button>
                <button
                  title="Nueva carpeta"
                  onClick={(e) => { e.stopPropagation(); setNewItemParent(entry.path); setNewItemType('dir'); }}
                >
                  <IconFolderPlus size={13} />
                </button>
              </span>
            </div>
            {inlineForm(entry.path, indent + 18)}
            {isExpanded && children.length > 0 && renderEntries(children, depth + 1, entry.path)}
          </div>
        );
      }

      return (
        <div
          key={entry.path}
          className={`filetree__node ${activePath === entry.path ? 'is-active' : ''}`}
          style={{ paddingLeft: indent + 17 }}
          onClick={() => handleSelectFile(entry.path, entry.name)}
          onContextMenu={(e) => openCtxMenu(e, entry, parentPath)}
        >
          {fileIcon(entry.name)}
          <span className="filetree__label">{entry.name}</span>
        </div>
      );
    });

  if (!rootPath) {
    return (
      <div className="filetree">
        <div className="filetree__empty">
          <p>Abre una carpeta para explorar y editar sus archivos.</p>
          <button className="pill-btn pill-btn--primary" onClick={handleOpenFolder}>
            Abrir carpeta
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="filetree">
      <div className="filetree__toolbar">
        <span className="filetree__root-name" title={rootPath}>{baseName(rootPath)}</span>
        <span className="filetree__actions">
          <button
            className="icon-btn"
            title="Nuevo archivo"
            onClick={() => { setNewItemParent(rootPath); setNewItemType('file'); }}
          >
            <IconFilePlus size={15} />
          </button>
          <button
            className="icon-btn"
            title="Nueva carpeta"
            onClick={() => { setNewItemParent(rootPath); setNewItemType('dir'); }}
          >
            <IconFolderPlus size={15} />
          </button>
          <button className="icon-btn" title="Refrescar" onClick={loadRoot}>
            <IconRefresh size={15} />
          </button>
          <button className="icon-btn" title="Cambiar carpeta" onClick={handleOpenFolder}>
            <IconFolderOpen size={15} />
          </button>
        </span>
      </div>

      {inlineForm(rootPath, 10)}
      {error && <p className="filetree__hint">{error}</p>}

      <div
        className="filetree__body"
        onContextMenu={(e) => openCtxMenu(e, null, rootPath)}
      >
        {treeData.length === 0 && !error ? (
          <p className="filetree__hint">Carpeta vacía.</p>
        ) : (
          renderEntries(treeData)
        )}
      </div>

      {ctxMenu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ctxItems().map((item, i) =>
            item.sep ? (
              <div key={i} className="ctx-menu__sep" />
            ) : (
              <button
                key={i}
                className={`ctx-menu__item ${item.danger ? 'is-danger' : ''}`}
                onClick={() => { setCtxMenu(null); item.run(); }}
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
