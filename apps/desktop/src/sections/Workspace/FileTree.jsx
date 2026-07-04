import React, { useState, useEffect } from 'react';
import { 
  LuFolder, 
  LuFolderOpen, 
  LuFile, 
  LuFileCode, 
  LuFolderPlus, 
  LuFilePlus, 
  LuRefreshCw,
  LuChevronRight,
  LuChevronDown
} from 'react-icons/lu';

// Importación dinámica de Tauri invoke y dialog
let invoke = null;
import('@tauri-apps/api/core')
  .then(m => {
    invoke = m.invoke;
  })
  .catch(err => {
    console.warn('Tauri invoke not loaded:', err);
  });

let openDialog = null;
import('@tauri-apps/plugin-dialog')
  .then(m => {
    openDialog = m.open;
  })
  .catch(err => {
    console.warn('Tauri dialog plugin not loaded:', err);
  });

export function FileTree({ onSelectFile, activeFilePath }) {
  const [rootPath, setRootPath] = useState('');
  const [treeData, setTreeData] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState({});
  const [dirChildren, setDirChildren] = useState({}); // { [path]: [entries] }
  
  // Estados para creación de archivos/directorios
  const [newItemParent, setNewItemParent] = useState(null); // path de carpeta
  const [newItemType, setNewItemType] = useState(null); // 'file' | 'dir'
  const [newItemName, setNewItemName] = useState('');

  const loadRoot = async () => {
    if (!invoke) return;
    try {
      const savedRoot = localStorage.getItem('folax_workspace_root');
      let root = savedRoot;
      if (!root) {
        root = await invoke('get_workspace_root');
      }
      setRootPath(root);
      const entries = await invoke('read_dir', { path: root });
      setTreeData(entries);
    } catch (e) {
      console.error('[filetree] Error cargando raíz:', e);
    }
  };

  const handlePathChange = async () => {
    if (!rootPath.trim() || !invoke) return;
    try {
      const entries = await invoke('read_dir', { path: rootPath.trim() });
      setTreeData(entries);
      localStorage.setItem('folax_workspace_root', rootPath.trim());
    } catch (e) {
      alert('Error abriendo el directorio: ' + e);
    }
  };

  const handleOpenFolder = async () => {
    if (!openDialog) {
      alert("El plugin de diálogo no está disponible.");
      return;
    }
    try {
      const selectedPath = await openDialog({
        directory: true,
        multiple: false,
        title: "Seleccionar Workspace"
      });
      if (selectedPath) {
        setRootPath(selectedPath);
        if (invoke) {
          const entries = await invoke('read_dir', { path: selectedPath });
          setTreeData(entries);
          localStorage.setItem('folax_workspace_root', selectedPath);
        }
      }
    } catch (e) {
      console.error("[filetree] Error abriendo diálogo:", e);
    }
  };

  useEffect(() => {
    loadRoot();
  }, []);

  const toggleDirectory = async (path) => {
    const isExpanded = !!expandedDirs[path];
    
    // Cambiar estado colapsado/expandido
    setExpandedDirs(prev => ({ ...prev, [path]: !isExpanded }));

    // Si se está expandiendo y no tiene datos, cargar contenido
    if (!isExpanded) {
      await refreshDirectory(path);
    }
  };

  const refreshDirectory = async (path) => {
    if (!invoke) return;
    try {
      const entries = await invoke('read_dir', { path });
      setDirChildren(prev => ({ ...prev, [path]: entries }));
    } catch (e) {
      console.error('[filetree] Error leyendo carpeta:', e);
    }
  };

  const handleCreateEntry = async (e) => {
    e.preventDefault();
    if (!newItemName.trim() || !invoke) return;

    const parent = newItemParent || rootPath;
    try {
      await invoke('create_new_entry', {
        parentPath: parent,
        name: newItemName.trim(),
        isDir: newItemType === 'dir'
      });

      // Refrescar carpeta correspondiente
      if (parent === rootPath) {
        await loadRoot();
      } else {
        await refreshDirectory(parent);
      }
    } catch (e) {
      alert('Error creando entrada: ' + e);
    } finally {
      setNewItemParent(null);
      setNewItemType(null);
      setNewItemName('');
    }
  };

  // Ícono dinámico según extensión
  const getFileIcon = (fileName) => {
    const ext = fileName.split('.').pop().toLowerCase();
    const style = { color: 'var(--text-secondary)' };

    if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) {
      return <LuFileCode size={16} style={{ color: 'var(--accent)' }} />;
    }
    if (['css', 'html', 'json'].includes(ext)) {
      return <LuFileCode size={16} style={{ color: 'var(--accent-alt)' }} />;
    }
    if (['py', 'rs', 'go'].includes(ext)) {
      return <LuFileCode size={16} style={{ color: 'var(--status-warn)' }} />;
    }

    return <LuFile size={16} style={style} />;
  };

  // Renderizador recursivo para nodos
  const renderEntries = (entries, depth = 0) => {
    return entries.map((entry) => {
      const isExpanded = !!expandedDirs[entry.path];
      const children = dirChildren[entry.path] || [];
      const isActiveFile = activeFilePath === entry.path;

      if (entry.is_dir) {
        return (
          <div key={entry.path} className="tree-node-group">
            <div 
              className="tree-node dir flex align-center justify-between"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => toggleDirectory(entry.path)}
            >
              <div className="flex align-center gap-1">
                {isExpanded ? <LuChevronDown size={14} /> : <LuChevronRight size={14} />}
                {isExpanded ? <LuFolderOpen size={16} style={{ color: 'var(--text-prompt)' }} /> : <LuFolder size={16} style={{ color: 'var(--text-prompt)' }} />}
                <span className="node-label font-mono">{entry.name}</span>
              </div>
              
              <div className="node-actions flex gap-1">
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewItemParent(entry.path);
                    setNewItemType('file');
                  }} 
                  title="Nuevo Archivo"
                >
                  <LuFilePlus size={12} />
                </button>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewItemParent(entry.path);
                    setNewItemType('dir');
                  }} 
                  title="Nueva Carpeta"
                >
                  <LuFolderPlus size={12} />
                </button>
              </div>
            </div>

            {/* Input inline para creación */}
            {newItemParent === entry.path && (
              <form onSubmit={handleCreateEntry} className="inline-create-form" style={{ marginLeft: `${(depth + 1) * 12 + 8}px` }}>
                <input
                  type="text"
                  placeholder={newItemType === 'file' ? 'nuevo-archivo.js' : 'nueva-carpeta'}
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  autoFocus
                  onBlur={() => {
                    setTimeout(() => {
                      setNewItemParent(null);
                      setNewItemType(null);
                    }, 200);
                  }}
                  className="inline-input font-mono"
                />
              </form>
            )}

            {isExpanded && children.length > 0 && (
              <div className="tree-children">
                {renderEntries(children, depth + 1)}
              </div>
            )}
            
            {isExpanded && children.length === 0 && (
              <div className="tree-empty-folder font-mono" style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}>
                (vacío)
              </div>
            )}
          </div>
        );
      } else {
        return (
          <div 
            key={entry.path} 
            className={`tree-node file flex align-center ${isActiveFile ? 'active' : ''}`}
            style={{ paddingLeft: `${depth * 12 + 22}px` }}
            onClick={() => onSelectFile(entry.path, entry.name)}
          >
            {getFileIcon(entry.name)}
            <span className="node-label font-mono">{entry.name}</span>
          </div>
        );
      }
    });
  };

  return (
    <div className="filetree-sidebar flex flex-col h-full">
      <div className="tree-header flex align-center justify-between">
        <span className="title font-mono">EXPLORER</span>
        <div className="flex gap-2">
          <button 
            onClick={() => {
              setNewItemParent(rootPath);
              setNewItemType('file');
            }} 
            title="Nuevo archivo en raíz"
            className="header-btn"
          >
            <LuFilePlus size={14} />
          </button>
          <button 
            onClick={() => {
              setNewItemParent(rootPath);
              setNewItemType('dir');
            }} 
            title="Nueva carpeta en raíz"
            className="header-btn"
          >
            <LuFolderPlus size={14} />
          </button>
          <button onClick={loadRoot} title="Refrescar Explorador" className="header-btn">
            <LuRefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="workspace-path-bar flex align-center gap-2">
        <button onClick={handleOpenFolder} title="Seleccionar Carpeta" className="header-btn" style={{ padding: '6px' }}>
          <LuFolderOpen size={16} />
        </button>
        <input 
          type="text" 
          value={rootPath} 
          onChange={(e) => setRootPath(e.target.value)} 
          onKeyDown={(e) => e.key === 'Enter' && handlePathChange()}
          placeholder="Ruta del workspace (ej: C:\Proyectos)"
          className="workspace-path-input font-mono"
        />
        <button onClick={handlePathChange} className="workspace-path-btn font-mono">
          Abrir
        </button>
      </div>

      <div className="tree-workspace-title flex align-center font-mono">
        <LuChevronDown size={14} />
        <span>LLM-DATACENT (WORKSPACE)</span>
      </div>

      {/* Formulario de creación en raíz */}
      {newItemParent === rootPath && (
        <form onSubmit={handleCreateEntry} className="inline-create-form" style={{ marginLeft: '12px' }}>
          <input
            type="text"
            placeholder={newItemType === 'file' ? 'nuevo-archivo.js' : 'nueva-carpeta'}
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            autoFocus
            onBlur={() => {
              setTimeout(() => {
                setNewItemParent(null);
                setNewItemType(null);
              }, 200);
            }}
            className="inline-input font-mono"
          />
        </form>
      )}

      <div className="tree-body flex-1">
        {treeData.length === 0 ? (
          <div className="empty-tree font-mono text-center">Cargando Workspace...</div>
        ) : (
          renderEntries(treeData)
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .filetree-sidebar {
          width: 100%;
          background-color: var(--bg-tree, #0f0f11);
          height: 100%;
        }
        .tree-header {
          padding: 10px 16px;
          border-bottom: 1px solid var(--border);
        }
        .workspace-path-bar {
          display: flex;
          gap: 6px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
        }
        .workspace-path-input {
          flex: 1;
          background-color: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--border);
          border-radius: 4px;
          color: #fff;
          font-size: 0.75rem;
          padding: 4px 8px;
          outline: none;
          min-width: 0;
          transition: border-color 0.2s;
        }
        .workspace-path-input:focus {
          border-color: var(--accent);
        }
        .light-theme .workspace-path-input {
          color: var(--text-primary);
          background-color: rgba(0, 0, 0, 0.02);
        }
        .workspace-path-btn {
          background-color: var(--accent);
          color: #fff;
          border: none;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 500;
          padding: 4px 10px;
          cursor: pointer;
          transition: filter 0.2s;
        }
        .workspace-path-btn:hover {
          filter: brightness(1.1);
        }
        .tree-header .title {
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--text-secondary);
          letter-spacing: 0.05em;
        }
        .header-btn {
          color: var(--text-secondary);
          cursor: pointer;
          transition: color 0.2s;
        }
        .header-btn:hover {
          color: #fff;
        }
        .tree-workspace-title {
          font-size: 0.75rem;
          font-weight: 700;
          color: #ffffff;
          padding: 10px 12px;
          cursor: pointer;
          gap: 4px;
        }
        .light-theme .tree-workspace-title {
          color: var(--text-primary);
        }
        .tree-body {
          overflow-y: auto;
          padding: 8px 0;
        }
        .tree-node {
          display: flex;
          align-items: center;
          padding: 6px 12px;
          cursor: pointer;
          font-size: 0.8rem;
          color: var(--text-secondary);
          transition: background-color 0.15s;
          gap: 6px;
        }
        .tree-node:hover {
          background-color: var(--bg-surface);
          color: #ffffff;
        }
        .light-theme .tree-node:hover {
          color: var(--text-primary);
        }
        .tree-node.file.active {
          color: var(--accent);
          background-color: rgba(var(--accent-rgb), 0.1);
          border-right: 2px solid var(--accent);
        }
        .node-label {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .node-actions {
          display: none;
        }
        .tree-node:hover .node-actions {
          display: flex;
        }
        .node-actions button {
          color: var(--text-muted);
          cursor: pointer;
        }
        .node-actions button:hover {
          color: #fff;
        }
        .inline-create-form {
          margin: 4px 8px;
        }
        .inline-input {
          background-color: var(--bg-primary);
          border: 1px solid var(--accent);
          border-radius: 4px;
          padding: 4px 8px;
          font-size: 0.75rem;
          color: #fff;
          width: 90%;
        }
        .light-theme .inline-input {
          color: var(--text-primary);
        }
        .tree-empty-folder {
          font-size: 0.75rem;
          color: var(--text-muted);
          padding: 4px 0;
        }
        .empty-tree {
          color: var(--text-muted);
          font-size: 0.8rem;
          padding: 20px;
        }
      `}} />
    </div>
  );
}
