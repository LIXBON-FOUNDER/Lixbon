// FileTree.jsx — explorador de archivos del workspace (panel izquierdo).
// Clic en un archivo → abre pestaña en el editor. Clic derecho → menú
// contextual (nuevo, renombrar, duplicar, copiar ruta, revelar, eliminar).
// La carpeta raíz vive en appStore.workspaceRoot (la fija openWorkspace).
import { useState, useEffect, useCallback, useRef } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  readDir, createNewEntry, renameEntry, deleteEntry, duplicateEntry,
  moveEntry, revealInOs, pickDirectory,
} from '../../lib/tauri';
import { useEditorStore } from '../../store/editorStore';
import { useAppStore } from '../../store/appStore';
import { useExtStore } from '../../store/extStore';
import { loadIconTheme, unloadIconTheme, iconDefIdFor, iconDataUrl } from '../../editor/iconTheme';
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

/** Icono del tema de iconos de VSCode activo (SVG → data-URL); si el tema no
    tiene icono para la entrada (o no hay tema) cae al icono propio. */
function ExtIcon({ name, isDir = false, expanded = false, fallback }) {
  const active = useExtStore((s) => s.activeIconTheme);
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!active) {
      unloadIconTheme();
      setUrl(null);
      return undefined;
    }
    (async () => {
      try {
        await loadIconTheme(active);
        const u = await iconDataUrl(iconDefIdFor(name, isDir, expanded));
        if (!cancelled) setUrl(u);
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [active, name, isDir, expanded]);

  if (!url) return fallback;
  return <img className="filetree__exticon" src={url} alt="" width={15} height={15} />;
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

  // Nodo seleccionado (destino de la tecla Supr): { entry, parent }
  const [selected, setSelected] = useState(null);
  // Drag & drop: origen arrastrado y carpeta resaltada como destino
  const dragSrc = useRef(null); // { entry, parent }
  const [dropTarget, setDropTarget] = useState(null); // path de la carpeta destino

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

  // Cambios en disco hechos por el agente del chat: recargar raíz y
  // carpetas expandidas (lib/agent.js emite 'lixbon:fs-changed')
  useEffect(() => {
    const onFsChanged = () => {
      loadRoot();
      for (const path of Object.keys(expandedDirs)) {
        if (expandedDirs[path]) refreshDirectory(path);
      }
    };
    window.addEventListener('lixbon:fs-changed', onFsChanged);
    return () => window.removeEventListener('lixbon:fs-changed', onFsChanged);
  }, [loadRoot, expandedDirs]);

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

  // Auto-reveal: al cambiar el archivo activo, expandir sus carpetas ancestro y
  // desplazar el árbol hasta él (sincroniza el explorador con el editor).
  useEffect(() => {
    if (!activePath || !rootPath || !activePath.startsWith(rootPath)) return undefined;
    const rel = activePath.slice(rootPath.length).replace(/^[\\/]+/, '');
    const parts = rel.split(/[\\/]/);
    parts.pop(); // nombre del archivo
    if (parts.length) {
      const sep = rootPath.includes('\\') ? '\\' : '/';
      let cur = rootPath.replace(/[\\/]+$/, '');
      const ancestors = [];
      for (const p of parts) { cur = cur + sep + p; ancestors.push(cur); }
      setExpandedDirs((prev) => {
        const next = { ...prev };
        for (const d of ancestors) next[d] = true;
        return next;
      });
      for (const d of ancestors) refreshDirectory(d);
    }
    const t = setTimeout(() => {
      document.querySelector('.filetree__node.is-active')?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, rootPath]);

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
      setSelected(null);
      await refreshParent(parent);
    } catch (err) {
      alert('Error eliminando: ' + err);
    }
  };

  // Tecla Supr: elimina el nodo seleccionado. Escucha en ventana pero con
  // guardia: no dispara si estás escribiendo (editor, inputs), para no borrar un
  // archivo sin querer mientras editas. Escape limpia la selección.
  useEffect(() => {
    const isTyping = (el) =>
      !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const onKey = (e) => {
      if (e.key === 'Escape') { setSelected(null); return; }
      if (e.key === 'Delete' && selected && !isTyping(document.activeElement)) {
        e.preventDefault();
        handleDelete(selected.entry, selected.parent);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDuplicate = async (entry, parent) => {
    try {
      await duplicateEntry(entry.path);
      await refreshParent(parent);
    } catch (err) {
      alert('Error duplicando: ' + err);
    }
  };

  // ── Mover (drag & drop) ──────────────────────────────────────────────

  const handleMove = async (src, destDir) => {
    if (!src) return;
    if (src.parent === destDir) return;      // ya está en esa carpeta
    if (src.entry.path === destDir) return;  // soltar sobre sí misma
    try {
      const newPath = await moveEntry(src.entry.path, destDir);
      useEditorStore.getState().remapPaths(src.entry.path, newPath);
      setSelected(null);
      setExpandedDirs((p) => ({ ...p, [destDir]: true }));
      await refreshParent(src.parent);
      await refreshParent(destDir);
    } catch (err) {
      alert('Error moviendo: ' + err);
    }
  };

  const startDrag = (e, entry, parent) => {
    dragSrc.current = { entry, parent };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.path);
  };

  // Sobre una carpeta: la resalta y permite soltar dentro.
  const onDirDragOver = (e, path) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== path) setDropTarget(path);
  };

  const onDirDrop = (e, path) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    handleMove(dragSrc.current, path);
    dragSrc.current = null;
  };

  // Sobre un archivo: se mueve a la carpeta que lo contiene (su padre).
  const onLeafDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };

  const onLeafDrop = (e, parent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    handleMove(dragSrc.current, parent);
    dragSrc.current = null;
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
              className={`filetree__node ${selected?.entry.path === entry.path ? 'is-active' : ''} ${dropTarget === entry.path ? 'is-drop-target' : ''}`}
              style={{ paddingLeft: indent }}
              draggable
              onDragStart={(e) => startDrag(e, entry, parentPath)}
              onDragOver={(e) => onDirDragOver(e, entry.path)}
              onDragLeave={() => setDropTarget((t) => (t === entry.path ? null : t))}
              onDrop={(e) => onDirDrop(e, entry.path)}
              onClick={() => { setSelected({ entry, parent: parentPath }); toggleDirectory(entry.path); }}
              onContextMenu={(e) => { setSelected({ entry, parent: parentPath }); openCtxMenu(e, entry, parentPath); }}
            >
              {isExpanded ? <IconChevron size={13} open /> : <IconChevronRight size={13} />}
              <ExtIcon
                name={entry.name}
                isDir
                expanded={isExpanded}
                fallback={isExpanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
              />
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
          className={`filetree__node ${activePath === entry.path || selected?.entry.path === entry.path ? 'is-active' : ''}`}
          style={{ paddingLeft: indent + 17 }}
          draggable
          onDragStart={(e) => startDrag(e, entry, parentPath)}
          onDragOver={onLeafDragOver}
          onDrop={(e) => onLeafDrop(e, parentPath)}
          onClick={() => { setSelected({ entry, parent: parentPath }); handleSelectFile(entry.path, entry.name); }}
          onContextMenu={(e) => { setSelected({ entry, parent: parentPath }); openCtxMenu(e, entry, parentPath); }}
        >
          <ExtIcon name={entry.name} fallback={fileIcon(entry.name)} />
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
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          handleMove(dragSrc.current, rootPath);
          dragSrc.current = null;
        }}
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
