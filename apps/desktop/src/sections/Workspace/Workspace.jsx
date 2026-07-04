import React, { useState } from 'react';
import { FileTree } from './FileTree';
import { CodeEditor } from './CodeEditor';

// Importación dinámica de Tauri invoke
let invoke = null;
import('@tauri-apps/api/core')
  .then(m => {
    invoke = m.invoke;
  })
  .catch(err => {
    console.warn('Tauri invoke not loaded:', err);
  });

export function Workspace() {
  const [activeFile, setActiveFile] = useState({
    path: '',
    name: '',
    content: ''
  });

  const handleSelectFile = async (path, name) => {
    if (!invoke) {
      alert('Tauri API no disponible');
      return;
    }

    try {
      const content = await invoke('read_file_content', { path });
      setActiveFile({ path, name, content });
    } catch (e) {
      alert('Error leyendo contenido del archivo: ' + e);
    }
  };

  const handleSaveSuccess = (path) => {
    // Sincronizar el contenido inicial con el guardado
    setActiveFile(prev => {
      if (prev.path === path) {
        return { ...prev, content: prev.content }; // El contenido modificado pasa a ser el inicial
      }
      return prev;
    });
  };

  return (
    <div className="workspace-view flex h-full flex-1">
      <FileTree 
        onSelectFile={handleSelectFile} 
        activeFilePath={activeFile.path} 
      />
      <CodeEditor
        filePath={activeFile.path}
        fileName={activeFile.name}
        initialContent={activeFile.content}
        onSaveSuccess={handleSaveSuccess}
      />

      <style dangerouslySetInnerHTML={{ __html: `
        .workspace-view {
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
          background-color: var(--bg-editor, #18181b);
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
          margin-top: 4px;
        }
      `}} />
    </div>
  );
}
