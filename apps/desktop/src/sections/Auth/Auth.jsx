import React, { useState } from 'react';
import { LoginView } from './LoginView';
import { RegisterView } from './RegisterView';
import { LuSparkles } from 'react-icons/lu';

export function Auth() {
  const [view, setView] = useState('login'); // 'login' | 'register'

  return (
    <div className="auth-overlay flex align-center justify-center">
      <div className="auth-container flex flex-col gap-4">
        <div className="brand-logo text-center">
          <div className="logo-glow">
            <LuSparkles size={40} className="glow-icon" />
          </div>
          <h1>FOLAX DTC</h1>
          <p className="subtitle">Distributed LLM Data & Task Cluster</p>
        </div>

        {view === 'login' ? (
          <LoginView onSwitchView={() => setView('register')} />
        ) : (
          <RegisterView onSwitchView={() => setView('login')} />
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .auth-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background-color: var(--bg-primary);
          background-image: radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.08) 0%, transparent 60%);
          z-index: 999;
          overflow-y: auto;
          padding: 40px 20px;
        }
        .auth-container {
          max-width: 440px;
          width: 100%;
          margin: auto;
        }
        .logo-glow {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: rgba(124, 58, 237, 0.08);
          border: 1px solid rgba(124, 58, 237, 0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 16px;
          box-shadow: 0 0 16px rgba(124, 58, 237, 0.15);
        }
        .glow-icon {
          color: var(--accent);
          filter: drop-shadow(0 0 4px var(--accent));
        }
        h1 {
          font-size: 1.8rem;
          font-weight: 800;
          color: #ffffff;
          letter-spacing: 0.05em;
          margin: 0;
        }
        .light-theme h1 {
          color: var(--text-primary);
        }
        .subtitle {
          font-size: 0.8rem;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-top: 4px;
        }
        .auth-form-card {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 32px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        .auth-header h2 {
          font-size: 1.25rem;
          color: #ffffff;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .light-theme .auth-header h2 {
          color: var(--text-primary);
        }
        .auth-header p {
          font-size: 0.8rem;
          color: var(--text-secondary);
        }
        .input-field-group label {
          font-size: 0.75rem;
          color: var(--text-secondary);
          font-weight: 500;
        }
        .input-wrapper {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 10px 14px;
          transition: border-color 0.2s;
        }
        .input-wrapper:focus-within {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.1);
        }
        .input-icon {
          color: var(--text-muted);
        }
        .auth-input {
          font-size: 0.85rem;
          color: #ffffff;
          width: 100%;
        }
        .light-theme .auth-input {
          color: var(--text-primary);
        }
        .error-banner {
          background-color: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 6px;
          padding: 10px 12px;
          color: var(--text-error);
          font-size: 0.75rem;
          line-height: 1.4;
        }
        .btn-auth-submit {
          background-color: var(--accent);
          color: #ffffff;
          font-weight: 600;
          font-size: 0.9rem;
          padding: 12px;
          border-radius: 6px;
          cursor: pointer;
          transition: opacity 0.2s;
          box-shadow: 0 4px 12px rgba(var(--accent-rgb), 0.3);
          margin-top: 10px;
        }
        .btn-auth-submit:hover:not(:disabled) {
          opacity: 0.95;
        }
        .btn-auth-submit:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .auth-footer {
          font-size: 0.8rem;
          color: var(--text-secondary);
          margin-top: 16px;
        }
        .switch-view-btn {
          color: var(--accent);
          font-weight: 600;
          cursor: pointer;
          text-decoration: underline;
        }
      `}} />
    </div>
  );
}
