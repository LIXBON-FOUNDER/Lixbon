import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../lib/api';
import { CommandInput } from './CommandInput';
import { MessageFeed } from './MessageFeed';
import { LuFileText, LuActivity } from 'react-icons/lu';

export function Terminal({ activeTab }) {
  const { 
    currentModel, 
    setCurrentModel, 
    availableModels, 
    setAvailableModels, 
    apiKey,
    messages,
    setMessages
  } = useAppStore();
  const [logs, setLogs] = useState([]);
  const [auditLimit, setAuditLimit] = useState(30);
  const [recentConvs, setRecentConvs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // Cargar modelos disponibles
  const loadModels = async () => {
    try {
      const res = await api.get('/v1/models');
      if (res && res.data) {
        setAvailableModels(res.data);
        if (!currentModel && res.data.length > 0) {
          setCurrentModel(res.data[0].id);
        }
      }
    } catch (e) {
      console.error('[terminal] Error cargando modelos:', e);
    }
  };

  // Cargar logs de auditoría (para pestaña Logs)
  const loadAuditLogs = async () => {
    try {
      const res = await api.get(`/api/audit?limit=${auditLimit}`);
      if (res && res.events) {
        setLogs(res.events);
      }
    } catch (e) {
      console.error('[terminal] Error cargando logs:', e);
    }
  };

  // Cargar conversaciones recientes (para pestaña Metrics/Activity)
  const loadRecentConversations = async () => {
    try {
      const res = await api.get('/api/dashboard/init');
      if (res && res.conversations) {
        setRecentConvs(res.conversations);
      }
    } catch (e) {
      console.error('[terminal] Error cargando conversaciones:', e);
    }
  };

  // Efecto para escuchar eventos del Sidebar (New Session y Clear Terminal)
  useEffect(() => {
    const handleNewSession = () => {
      setMessages([
        { role: 'system', content: 'Iniciando una nueva sesión limpia. Escribe tu comando o mensaje.', type: 'info' }
      ]);
    };

    const handleClearTerminal = () => {
      setMessages([]);
    };

    window.addEventListener('new-session-click', handleNewSession);
    window.addEventListener('clear-terminal-click', handleClearTerminal);
    
    return () => {
      window.removeEventListener('new-session-click', handleNewSession);
      window.removeEventListener('clear-terminal-click', handleClearTerminal);
    };
  }, [setMessages]);

  // Cargar datos según pestaña
  useEffect(() => {
    loadModels();
    if (activeTab === 'logs') {
      loadAuditLogs();
    } else if (activeTab === 'metrics') {
      loadRecentConversations();
    }
  }, [activeTab]);

  // Manejar el envío de un comando/mensaje
  const handleSendCommand = async (text) => {
    if (!text.trim()) return;

    // Agregar el mensaje del usuario
    const userMsg = { role: 'user', content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setIsLoading(true);

    // Si es un comando de tipo barra (ej. /model o /help)
    if (text.startsWith('/')) {
      const parts = text.split(' ');
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ');

      if (cmd === '/help') {
        setTimeout(() => {
          setMessages([...updatedMessages, {
            role: 'system',
            content: 'Comandos Disponibles:\n  /model <nombre> - Cambia el modelo activo\n  /clear          - Limpia la pantalla\n  /info           - Muestra estado actual del cluster\n  /help           - Muestra esta lista',
            type: 'info'
          }]);
          setIsLoading(false);
        }, 300);
        return;
      }

      if (cmd === '/clear') {
        setMessages([]);
        setIsLoading(false);
        return;
      }

      if (cmd === '/model') {
        if (!arg) {
          setMessages([...updatedMessages, {
            role: 'system',
            content: `Modelo activo: ${currentModel || 'Ninguno'}. Modelos disponibles:\n` + 
                     availableModels.map(m => ` - ${m.id}`).join('\n'),
            type: 'info'
          }]);
        } else {
          const match = availableModels.find(m => m.id.toLowerCase().includes(arg.toLowerCase()));
          if (match) {
            setCurrentModel(match.id);
            setMessages([...updatedMessages, {
              role: 'system',
              content: `[OK] Modelo cambiado correctamente a: ${match.id}`,
              type: 'ok'
            }]);
          } else {
            setMessages([...updatedMessages, {
              role: 'system',
              content: `[ERROR] Modelo "${arg}" no encontrado.`,
              type: 'error'
            }]);
          }
        }
        setIsLoading(false);
        return;
      }
    }

    // Interactuar con el backend
    try {
      const res = await api.post('/api/chat', {
        model: currentModel || 'default',
        message: text
      });

      if (res && res.message) {
        setMessages([...updatedMessages, { role: 'assistant', content: res.message }]);
      } else {
        setMessages([...updatedMessages, { role: 'system', content: '[OK] Mensaje registrado en el clúster.', type: 'ok' }]);
      }
    } catch (e) {
      setMessages([...updatedMessages, { role: 'system', content: `[ERROR] Fallo en la comunicación: ${e.message}`, type: 'error' }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="terminal-container flex flex-col h-full flex-1">
      {activeTab === 'cluster' && (
        <>
          <div className="terminal-feed-wrapper flex-1">
            <MessageFeed messages={messages} isLoading={isLoading} />
          </div>
          <CommandInput onSend={handleSendCommand} isLoading={isLoading} />
        </>
      )}

      {activeTab === 'logs' && (
        <div className="logs-view flex flex-col gap-4">
          <div className="flex justify-between align-center">
            <h3>LOGS DE AUDITORÍA</h3>
            <button onClick={loadAuditLogs} className="btn-refresh">Refrescar Logs</button>
          </div>
          <div className="log-list flex flex-col gap-2 font-mono">
            {logs.length === 0 ? (
              <div className="no-logs">No hay eventos recientes en el clúster.</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="log-row">
                  <span className="log-time">[{log.created_at.slice(11, 19)}]</span>
                  <span className="log-type" style={{ color: log.event_type.includes('fail') ? 'var(--text-error)' : 'var(--text-terminal)' }}>
                    {log.event_type.toUpperCase()}
                  </span>
                  <span className="log-ip">{log.ip_address || 'local'}</span>
                  <span className="log-desc">{JSON.stringify(log.metadata)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'metrics' && (
        <div className="activity-view flex flex-col gap-4">
          <h3>ACTIVIDAD RECIENTE DEL CLÚSTER</h3>
          <div className="activity-list flex flex-col gap-2 font-mono">
            {recentConvs.length === 0 ? (
              <div className="no-logs">No hay conversaciones registradas recientemente.</div>
            ) : (
              recentConvs.map((conv) => (
                <div key={conv.id} className="activity-row flex justify-between">
                  <div className="flex align-center gap-2">
                    <span className="bullet">⚡</span>
                    <span className="activity-title">{conv.title}</span>
                  </div>
                  <span className="activity-date">{conv.updated_at.slice(0, 10)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .terminal-container {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
          box-shadow: inset 0 0 20px rgba(0,0,0,0.8);
        }
        .terminal-feed-wrapper {
          overflow-y: auto;
          padding: 24px;
        }
        .logs-view, .activity-view {
          padding: 24px;
          height: 100%;
          overflow-y: auto;
        }
        .logs-view h3, .activity-view h3 {
          font-size: 1rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: #fff;
        }
        .btn-refresh {
          background-color: var(--bg-surface);
          border: 1px solid var(--border);
          padding: 6px 12px;
          font-size: 0.75rem;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn-refresh:hover {
          border-color: var(--accent);
          color: #fff;
        }
        .log-list, .activity-list {
          background-color: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 16px;
          font-size: 0.8rem;
          flex-1: 1;
          overflow-y: auto;
        }
        .log-row {
          display: flex;
          gap: 12px;
          padding: 4px 0;
          border-bottom: 1px dashed rgba(255,255,255,0.02);
          color: var(--text-secondary);
        }
        .log-time {
          color: var(--text-muted);
        }
        .log-ip {
          color: var(--accent-alt);
        }
        .log-desc {
          color: var(--text-primary);
        }
        .activity-row {
          padding: 10px;
          border-bottom: 1px solid var(--border);
        }
        .activity-title {
          color: var(--text-primary);
        }
        .activity-date {
          color: var(--text-secondary);
        }
        .no-logs {
          color: var(--text-muted);
          text-align: center;
          padding: 20px;
        }
      `}} />
    </div>
  );
}
