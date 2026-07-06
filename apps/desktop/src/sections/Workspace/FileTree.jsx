// FileTree.jsx — explorador de archivos del workspace (panel izquierdo).
// Clic en un archivo → abre pestaña en el editor (editorStore.openFile).
import { useState, useEffect, useCallback } from 'react';
import { readDir, createNewEntry, pickDirectory, setWorkspaceRoot } from '../../lib/tauri';
import { useEditorStore } from '../../store/editorStore';
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

  const [rootPath, setRootPath] = useState(() => localStorage.getItem('lixbon_workspace_root') || '');
  const [treeData, setTreeData] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState({});
  const [dirChildren, setDirChildren] = useState({});
  const [error, setError] = useState('');

  // Creación inline de archivos/carpetas
  const [newItemParent, setNewItemParent] = useState(null);
  const [newItemType, setNewItemType] = useState(null); // 'file' | 'dir'
  const [newItemName, setNewItemName] = useState('');

  const loadRoot = useCallback(async (root) => {
    if (!root) return;
    setError('');
    try {
      // Fija el sandbox en Rust y devuelve la ruta canónica
      const canonical = await setWorkspaceRoot(root);
      const entries = await readDir(canonical);
      setTreeData(entries);
      setRootPath(canonical);
      localStorage.setItem('lixbon_workspace_root', canonical);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (rootPath) loadRoot(rootPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenFolder = async () => {
    try {
      const selected = await pickDirectory({ title: 'Abrir carpeta de trabajo' });
      if (selected) {
        setExpandedDirs({});
        setDirChildren({});
        await loadRoot(selected);
      }
    } catch (e) {
      console.error('[filetree] Error abriendo diálogo:', e);
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
      if (parent === rootPath) await loadRoot(rootPath);
      else await refreshDirectory(parent);
    } catch (err) {
      alert('Error creando entrada: ' + err);
    } finally {
      setNewItemParent(null);
      setNewItemType(null);
      setNewItemName('');
    }
  };

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

  const renderEntries = (entries, depth = 0) =>
    entries.map((entry) => {
      const indent = depth * 14 + 10;

      if (entry.is_dir) {
        const isExpanded = !!expandedDirs[entry.path];
        const children = dirChildren[entry.path] || [];
        return (
          <div key={entry.path}>
            <div
              className="filetree__node"
              style={{ paddingLeft: indent }}
              onClick={() => toggleDirectory(entry.path)}
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
            {isExpanded && children.length > 0 && renderEntries(children, depth + 1)}
          </div>
        );
      }

      return (
        <div
          key={entry.path}
          className={`filetree__node ${activePath === entry.path ? 'is-active' : ''}`}
          style={{ paddingLeft: indent + 17 }}
          onClick={() => handleSelectFile(entry.path, entry.name)}
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
          <button className="icon-btn" title="Refrescar" onClick={() => loadRoot(rootPath)}>
            <IconRefresh size={15} />
          </button>
          <button className="icon-btn" title="Cambiar carpeta" onClick={handleOpenFolder}>
            <IconFolderOpen size={15} />
          </button>
        </span>
      </div>

      {inlineForm(rootPath, 10)}
      {error && <p className="filetree__hint">{error}</p>}

      <div className="filetree__body">
        {treeData.length === 0 && !error ? (
          <p className="filetree__hint">Carpeta vacía.</p>
        ) : (
          renderEntries(treeData)
        )}
      </div>
    </div>
  );
}
