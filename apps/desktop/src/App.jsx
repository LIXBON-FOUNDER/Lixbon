import React, { useState } from 'react';
import { useAppStore } from './store/appStore';
import { useTheme } from './hooks/useTheme';
import { useConnection } from './hooks/useConnection';
import { useVersion } from './hooks/useVersion';

// Layout Components
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Onboarding } from './components/Onboarding';
import { UpdateBanner } from './components/UpdateBanner';

// Section Pages
import { Auth } from './sections/Auth/Auth';
import { Workspace } from './sections/Workspace/Workspace'; // Se mantendrá por compatibilidad temporal
import { FileTree } from './sections/Workspace/FileTree';
import { CodeEditor } from './sections/Workspace/CodeEditor';
import { Terminal } from './sections/Terminal/Terminal';
import { Metrics } from './sections/Metrics/Metrics';
import { Services } from './sections/Services/Services';
import { Commands } from './sections/Commands/Commands';
import { Settings } from './sections/Settings/Settings';

let invoke = null;
import('@tauri-apps/api/core')
  .then(m => {
    invoke = m.invoke;
  })
  .catch(err => {
    console.warn('Tauri invoke not loaded in App.jsx:', err);
  });

export default function App() {
  // Inicializar hooks de ciclo de vida
  useTheme();
  useConnection();
  const { 
    updateInfo, 
    installUpdate, 
    isDownloading, 
    downloadProgress 
  } = useVersion();

  const { 
    serverUrl, 
    activeSection, 
    setActiveSection,
    apiKey, 
    isWorkspaceVisible, 
    activeFile, 
    setActiveFile 
  } = useAppStore();
  
  const [activeTab, setActiveTab] = useState('cluster'); // Usado por Terminal (Cluster | Logs | Metrics)

  // Si no se ha configurado la URL del túnel, obligar Onboarding
  if (!serverUrl) {
    return <Onboarding />;
  }

  // Si no hay API Key de sesión activa, obligar Login
  if (!apiKey) {
    return <Auth />;
  }

  const handleSelectFile = async (path, name) => {
    if (!invoke) {
      alert('Tauri API no disponible aún');
      return;
    }
    try {
      const content = await invoke('read_file_content', { path });
      setActiveFile({ path, name, content });
      setActiveSection('editor');
    } catch (e) {
      alert('Error leyendo contenido del archivo: ' + e);
    }
  };

  const handleSaveSuccess = (path) => {
    if (activeFile && activeFile.path === path) {
      setActiveFile({ ...activeFile, content: activeFile.content });
    }
  };

  // Renderizado dinámico de la sección seleccionada
  const renderSection = () => {
    switch (activeSection) {
      case 'terminal':
        return <Terminal activeTab={activeTab} />;
      case 'editor':
        return activeFile ? (
          <CodeEditor
            filePath={activeFile.path}
            fileName={activeFile.name}
            initialContent={activeFile.content}
            onSaveSuccess={handleSaveSuccess}
          />
        ) : (
          <div className="flex h-full align-center justify-center text-muted">No hay archivo abierto</div>
        );
      case 'workspace': // Fallback o si el usuario quiere la vista vieja
        return <Workspace />;
      case 'metrics':
        return <Metrics />;
      case 'services':
        return <Services />;
      case 'commands':
        return <Commands />;
      case 'settings':
        return <Settings />;
      default:
        return <Terminal activeTab={activeTab} />;
    }
  };

  // Paddings adaptativos para que el chat y el editor ocupen todo el espacio disponible
  const isFullScreenSection = activeSection === 'terminal' || activeSection === 'editor';

  return (
    <div className="app-container">
      <Sidebar />
      {isWorkspaceVisible && (
        <div className="filetree-sidebar-wrapper">
          <FileTree onSelectFile={handleSelectFile} activeFilePath={activeFile?.path} />
        </div>
      )}
      <div className="main-content">
        <TopBar activeTab={activeTab} setActiveTab={setActiveTab} />
        
        <UpdateBanner 
          updateInfo={updateInfo}
          onInstall={installUpdate}
          isDownloading={isDownloading}
          downloadProgress={downloadProgress}
        />
        
        <div className="section-container" style={{ padding: isFullScreenSection ? '0' : '24px' }}>
          {renderSection()}
        </div>
      </div>
    </div>
  );
}
