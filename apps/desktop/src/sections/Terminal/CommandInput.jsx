import React, { useState, useEffect, useRef } from 'react';
import { LuSend } from 'react-icons/lu';

export function CommandInput({ onSend, isLoading }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('folax_cmd_history') || '[]');
    } catch {
      return [];
    }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef(null);

  // Focus input automatically
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  // Escuchar evento de ejecución (Execute en TopBar)
  useEffect(() => {
    const handleExecuteClick = () => {
      handleSend();
    };
    window.addEventListener('execute-command-click', handleExecuteClick);
    return () => {
      window.removeEventListener('execute-command-click', handleExecuteClick);
    };
  }, [input, history]);

  const handleSend = () => {
    if (!input.trim() || isLoading) return;

    const trimmed = input.trim();
    onSend(trimmed);

    // Guardar en historial
    const newHistory = [trimmed, ...history.filter(h => h !== trimmed)].slice(0, 50);
    setHistory(newHistory);
    localStorage.setItem('folax_cmd_history', JSON.stringify(newHistory));
    setHistoryIndex(-1);
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSend();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex < history.length) {
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = historyIndex - 1;
      if (nextIndex >= 0) {
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex]);
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Autocompletado básico
      const commands = ['/help', '/model', '/clear', '/info'];
      if (input.startsWith('/')) {
        const match = commands.find(c => c.startsWith(input));
        if (match) {
          setInput(match);
        }
      }
    }
  };

  return (
    <div className="command-input-container flex align-center gap-2">
      <span className="prompt-symbol font-mono">&gt;</span>
      <input
        ref={inputRef}
        type="text"
        placeholder="Enter a message or command..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isLoading}
        className="terminal-input font-mono"
      />
      <button 
        onClick={handleSend} 
        disabled={isLoading || !input.trim()}
        className="btn-send flex align-center justify-center"
      >
        <LuSend size={16} />
      </button>

      <style dangerouslySetInnerHTML={{ __html: `
        .command-input-container {
          background-color: var(--bg-input);
          border-top: 1px solid var(--border);
          padding: 16px 24px;
        }
        .prompt-symbol {
          color: var(--accent);
          font-weight: 700;
          font-size: var(--font-size-terminal);
        }
        .terminal-input {
          flex: 1;
          font-size: var(--font-size-terminal);
          color: #ffffff;
        }
        .light-theme .terminal-input {
          color: var(--text-primary);
        }
        .terminal-input::placeholder {
          color: var(--text-muted);
        }
        .btn-send {
          color: var(--text-secondary);
          cursor: pointer;
          padding: 8px;
          border-radius: 4px;
          transition: all 0.2s;
        }
        .btn-send:hover:not(:disabled) {
          color: var(--accent);
          background-color: var(--bg-surface);
        }
        .btn-send:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
      `}} />
    </div>
  );
}
