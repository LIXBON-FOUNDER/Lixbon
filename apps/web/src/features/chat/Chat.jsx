import React, { useEffect, useState, useRef } from 'react';
import { api } from '../../lib/api';
import { LuBot, LuSend, LuTriangleAlert, LuInfo, LuUser, LuSettings, LuCopy, LuLoader } from 'react-icons/lu';
import '../../style/Chat.css';

export default function Chat() {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [ollamaOk, setOllamaOk] = useState(true);
  const [messages, setMessages] = useState([]);
  
  const messagesEndRef = useRef(null);

  useEffect(() => {
    api.get('/api/dashboard/init')
      .then(res => {
        const m = res.data.models || [];
        setModels(m);
        if (m.length > 0) {
          const firstModel = m[0].id;
          setSelectedModel(firstModel);
          setOllamaOk(!firstModel.startsWith('error:'));
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!selectedModel || !inputMessage.trim() || loading) return;

    const userText = inputMessage.trim();
    setInputMessage('');
    
    setMessages(prev => [...prev, { role: 'user', content: userText }]);
    setLoading(true);

    try {
      const res = await api.post('/api/chat', {
        model: selectedModel,
        message: userText
      });
      
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: res.data.message || 'Sin respuesta',
        usage: res.data.usage,
        latency: res.data.latency_ms
      }]);
    } catch (err) {
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        error: true,
        content: err.response?.data?.detail || err.message || 'Error al conectar con el servidor'
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  // Helper to render markdown-like code blocks
  const renderContent = (content) => {
    if (!content) return null;
    const parts = content.split(/(```[\w]*\n[\s\S]*?```)/g);
    
    return parts.map((part, idx) => {
      if (part.startsWith('```')) {
        const match = part.match(/```([\w]*)\n([\s\S]*?)```/);
        const lang = match ? match[1] : '';
        const code = match ? match[2] : part.replace(/```/g, '');
        return (
          <div key={idx} className="code-block-wrapper">
            <div className="code-block-header">
              <span>{lang || 'CODE'}</span>
              <button 
                onClick={() => copyToClipboard(code.trim())}
                className="code-block-copy"
              >
                <LuCopy size={14} /> Copy
              </button>
            </div>
            <pre className="code-block-content">
              <code>{code.trim()}</code>
            </pre>
          </div>
        );
      }
      return <p key={idx} className="code-block-text">{part}</p>;
    });
  };

  return (
    <div id="chat" className="section-content active chat-container">
      
      {/* Header matching the screenshot */}
      <header className="chat-header">
        <div className="chat-header-left">
          <h2 className="chat-title">Interactive Chat Test</h2>
          {ollamaOk ? (
            <span className="badge badge-active chat-badge">● Connected</span>
          ) : (
            <span className="badge chat-badge chat-badge-disconnected">● Disconnected</span>
          )}
        </div>
        
        <div className="chat-header-right">
          <div className="model-selector-wrapper">
            <span className="model-selector-label">MODEL:</span>
            <select 
              value={selectedModel}
              onChange={(e) => {
                setSelectedModel(e.target.value);
                setOllamaOk(!e.target.value.startsWith('error:'));
              }}
              className="model-selector"
            >
              {models.map((m, idx) => (
                <option key={idx} value={m.id}>{m.id}</option>
              ))}
            </select>
          </div>
          <LuSettings size={18} className="settings-icon" />
        </div>
      </header>

      {/* Messages Area */}
      <div className="chat-messages chat-messages-area">
        
        {/* Persistent System Message */}
        <div className="message system msg-system">
          <div className="msg-system-icon">
            <LuInfo size={14} />
          </div>
          <div>System initialized. Connected to model '{selectedModel || 'llama-3-8b-instruct'}' on Local Cluster Node 01.</div>
        </div>

        {/* Dynamic Messages */}
        {messages.map((msg, idx) => {
          if (msg.role === 'user') {
            return (
              <div key={idx} className="message user msg-user-wrapper">
                <div className="msg-user-content">
                  {msg.content}
                </div>
                <div className="msg-user-icon">
                  <LuUser size={16} />
                </div>
              </div>
            );
          } else {
            return (
              <div key={idx} className="message assistant msg-assistant-wrapper">
                <div className="msg-assistant-icon">
                  <LuBot size={18} />
                </div>
                <div className={`msg-assistant-content ${msg.error ? 'msg-assistant-error' : ''}`}>
                  {renderContent(msg.content)}
                  {msg.usage && (
                    <div className="msg-metrics">
                      Tokens: {msg.usage.total_tokens} | Latencia: {msg.latency} ms
                    </div>
                  )}
                </div>
              </div>
            );
          }
        })}

        {loading && (
          <div className="message assistant msg-assistant-wrapper">
            <div className="msg-assistant-icon">
              <LuBot size={18} />
            </div>
            <div className="msg-loading">
              <LuLoader className="spinner" size={16} /> 
              Generando respuesta...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="chat-input-area">
        <form onSubmit={handleSubmit} className="chat-form">
          <textarea 
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escribe tu prompt de prueba aquí (Shift+Enter para nueva línea)..."
            disabled={loading || !ollamaOk}
            className="chat-textarea"
          />
          <button 
            type="submit" 
            disabled={loading || !inputMessage.trim() || !ollamaOk} 
            className={`chat-submit-btn ${(inputMessage.trim() && !loading) ? 'active' : 'disabled'}`}
          >
            <LuSend size={20} />
          </button>
        </form>
      </div>
    </div>
  );
}
