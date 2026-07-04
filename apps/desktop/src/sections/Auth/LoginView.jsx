import React, { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { LuUser, LuLock, LuArrowRight, LuCircleAlert } from 'react-icons/lu';

export function LoginView({ onSwitchView }) {
  const { serverUrl, setApiKey, setUser, setConnectionStatus } = useAppStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Por favor completa todos los campos');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || 'Fallo al iniciar sesión');
      }

      setApiKey(data.api_key);
      setUser(data.user);
      setConnectionStatus('connected');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-form-card flex flex-col gap-4">
      <div className="auth-header text-center">
        <h2>Iniciar Sesión</h2>
        <p>Introduce tus credenciales para acceder al clúster</p>
      </div>

      <form onSubmit={handleLogin} className="flex flex-col gap-4">
        <div className="input-field-group flex flex-col gap-1">
          <label htmlFor="login-username">Usuario</label>
          <div className="input-wrapper flex align-center gap-2">
            <LuUser size={16} className="input-icon" />
            <input
              id="login-username"
              type="text"
              placeholder="admin"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isLoading}
              className="auth-input"
            />
          </div>
        </div>

        <div className="input-field-group flex flex-col gap-1">
          <label htmlFor="login-password">Contraseña</label>
          <div className="input-wrapper flex align-center gap-2">
            <LuLock size={16} className="input-icon" />
            <input
              id="login-password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
              className="auth-input"
            />
          </div>
        </div>

        {error && (
          <div className="error-banner flex align-center gap-2">
            <LuCircleAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        <button 
          type="submit" 
          disabled={isLoading || !username.trim() || !password.trim()}
          className="btn-auth-submit flex align-center justify-center gap-2"
        >
          <span>{isLoading ? 'Iniciando sesión...' : 'Ingresar'}</span>
          {!isLoading && <LuArrowRight size={16} />}
        </button>
      </form>

      <div className="auth-footer text-center">
        <span>¿No tienes una cuenta? </span>
        <button onClick={onSwitchView} className="switch-view-btn">
          Regístrate aquí
        </button>
      </div>
    </div>
  );
}
