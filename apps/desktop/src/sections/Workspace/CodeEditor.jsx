import React, { useState, useEffect, useRef } from 'react';
import { LuSave, LuFileText } from 'react-icons/lu';

// Importación dinámica de Tauri invoke
let invoke = null;
import('@tauri-apps/api/core')
  .then(m => {
    invoke = m.invoke;
  })
  .catch(err => {
    console.warn('Tauri invoke not loaded:', err);
  });

export function CodeEditor({ filePath, fileName, initialContent, onSaveSuccess }) {
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);
  const [isModified, setIsModified] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    setContent(initialContent);
    setIsModified(false);
  }, [filePath, initialContent]);

  // Manejar Ctrl+S para Guardado rápido
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [content, filePath]);

  const handleSave = async () => {
    if (!filePath || !invoke || isSaving) return;
    setIsSaving(true);
    try {
      await invoke('write_file_content', { path: filePath, content });
      setIsModified(false);
      if (onSaveSuccess) onSaveSuccess(filePath);
    } catch (e) {
      alert('Error guardando archivo: ' + e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTextChange = (e) => {
    setContent(e.target.value);
    setIsModified(e.target.value !== initialContent);
  };

  // Calcular líneas para columna izquierda de números de línea
  const lines = content.split('\n');

  if (!filePath) {
    return (
      <div className="empty-editor flex flex-col align-center justify-center flex-1">
        <LuFileText size={48} style={{ color: 'var(--text-muted)', marginBottom: '16px' }} />
        <h3>Ningún archivo abierto</h3>
        <p>Selecciona un archivo del explorador lateral para comenzar a editar</p>
      </div>
    );
  }

  return (
    <div className="code-editor-container flex flex-col flex-1 h-full">
      {/* Pestaña del Editor */}
      <div className="editor-tab-header flex justify-between align-center">
        <div className="tab flex align-center gap-2 font-mono active">
          <LuFileText size={14} style={{ color: 'var(--accent)' }} />
          <span>{fileName}</span>
          {isModified && <span className="modified-dot" title="Modificado sin guardar"></span>}
        </div>

        <button 
          onClick={handleSave} 
          disabled={isSaving || !isModified}
          className="btn-save flex align-center gap-1 font-mono"
        >
          <LuSave size={14} />
          <span>{isSaving ? 'Guardando...' : 'SAVE'}</span>
        </button>
      </div>

      {/* Cuerpo del Editor estilo VS Code */}
      <div className="editor-body flex flex-1">
        {/* Columna de números de línea */}
        <div className="line-numbers font-mono">
          {lines.map((_, i) => (
            <div key={i} className="line-num">{i + 1}</div>
          ))}
        </div>

        {/* Textarea del editor */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleTextChange}
          className="editor-textarea font-mono flex-1"
          spellCheck="false"
        />
      </div>

      <div className="editor-footer flex justify-between font-mono">
        <span className="file-path">{filePath}</span>
        <span className="editor-stats">Lineas: {lines.length} · UTF-8</span>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .code-editor-container {
          background-color: var(--bg-editor, #18181b);
        }
        .empty-editor {
          background-color: var(--bg-editor, #18181b);
          color: var(--text-secondary);
        }
        .empty-editor h3 {
          font-size: 1.1rem;
          color: #fff;
          margin-bottom: 4px;
        }
        .empty-editor p {
          font-size: 0.8rem;
          color: var(--text-muted);
        }
        .editor-tab-header {
          background-color: var(--bg-tree, #0f0f11);
          height: 36px;
          border-bottom: 1px solid var(--border);
          padding-right: 16px;
        }
        .editor-tab-header .tab {
          background-color: var(--bg-editor, #18181b);
          border-right: 1px solid var(--border);
          height: 100%;
          padding: 0 16px;
          font-size: 0.8rem;
          color: #fff;
          cursor: pointer;
          position: relative;
        }
        .modified-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background-color: var(--status-warn);
          display: inline-block;
        }
        .btn-save {
          background-color: var(--accent);
          color: #fff;
          font-weight: 700;
          font-size: 0.75rem;
          padding: 4px 10px;
          border-radius: 4px;
          cursor: pointer;
          transition: opacity 0.2s;
        }
        .btn-save:hover:not(:disabled) {
          opacity: 0.9;
        }
        .btn-save:disabled {
          background-color: var(--bg-surface);
          color: var(--text-muted);
          cursor: not-allowed;
          border: 1px solid var(--border);
        }
        .editor-body {
          position: relative;
          overflow: hidden;
        }
        .line-numbers {
          width: 44px;
          text-align: right;
          padding: 16px 12px 16px 0;
          color: var(--text-muted);
          font-size: 0.85rem;
          background-color: var(--bg-tree, #0f0f11);
          border-right: 1px solid var(--border);
          user-select: none;
        }
        .line-num {
          height: 22px;
          line-height: 22px;
        }
        .editor-textarea {
          resize: none;
          padding: 16px;
          background-color: var(--bg-editor, #18181b);
          color: #e4e4e7;
          font-size: 0.85rem;
          line-height: 22px;
          overflow-y: auto;
          white-space: pre;
          tab-size: 4;
        }
        .light-theme .editor-textarea {
          color: var(--text-primary);
        }
        .editor-footer {
          background-color: var(--bg-tree, #0f0f11);
          height: 22px;
          border-top: 1px solid var(--border);
          padding: 0 16px;
          display: flex;
          align-items: center;
          font-size: 0.7rem;
          color: var(--text-secondary);
        }
        .file-path {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 70%;
        }
      `}} />
    </div>
  );
}
