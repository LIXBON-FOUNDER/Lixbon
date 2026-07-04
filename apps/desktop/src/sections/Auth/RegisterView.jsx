import React, { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { LuUser, LuLock, LuArrowRight, LuCircleAlert } from 'react-icons/lu';

export function RegisterView({ onSwitchView }) {
  const { serverUrl, setApiKey, setUser, setConnectionStatus } = useAppStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Por favor completa todos los campos');
      return;
    }
    
    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || 'Fallo al registrar usuario');
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
        <h2>Crear Cuenta</h2>
        <p>Regístrate para desplegar agentes e interactuar en el clúster</p>
      </div>

      <form onSubmit={handleRegister} className="flex flex-col gap-4">
        <div className="input-field-group flex flex-col gap-1">
          <label htmlFor="reg-username">Usuario</label>
          <div className="input-wrapper flex align-center gap-2">
            <LuUser size={16} className="input-icon" />
            <input
              id="reg-username"
              type="text"
              placeholder="nuevo_usuario"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isLoading}
              className="auth-input"
            />
          </div>
        </div>

        <div className="input-field-group flex flex-col gap-1">
          <label htmlFor="reg-password">Contraseña</label>
          <div className="input-wrapper flex align-center gap-2">
            <LuLock size={16} className="input-icon" />
            <input
              id="reg-password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
              className="auth-input"
            />
          </div>
        </div>

        <div className="input-field-group flex flex-col gap-1">
          <label htmlFor="reg-confirm-password">Confirmar Contraseña</label>
          <div className="input-wrapper flex align-center gap-2">
            <LuLock size={16} className="input-icon" />
            <input
              id="reg-confirm-password"
              type="password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
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
          disabled={isLoading || !username.trim() || !password.trim() || !confirmPassword.trim()}
          className="btn-auth-submit flex align-center justify-center gap-2"
        >
          <span>{isLoading ? 'Creando cuenta...' : 'Registrar'}</span>
          {!isLoading && <LuArrowRight size={16} />}
        </button>
      </form>

      <div className="auth-footer text-center">
        <span>¿Ya tienes una cuenta? </span>
        <button onClick={onSwitchView} className="switch-view-btn">
          Inicia sesión aquí
        </button>
      </div>
    </div>
  );
}
