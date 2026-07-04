import React, { useState } from 'react';
import { useAuth } from './AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import { LuTerminal, LuUser, LuLock, LuArrowRight } from 'react-icons/lu';
import '../../style/Auth.css';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.detail || 'Credenciales incorrectas');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-wrapper">
        <div className="auth-card">
          <div className="auth-topbar">
            <div className="auth-topbar-icon">
              <LuTerminal size={16} />
            </div>
          </div>
          
          <div className="auth-card-body">
            <div className="auth-header">
              <h2>Bienvenido</h2>
              <p>Acceso a Folax DTC</p>
            </div>
            
            {error && (
              <div className="error-box auth-error-box">
                {error}
              </div>
            )}

              <form id="loginForm" onSubmit={handleSubmit}>
                <div className="input-group">
                  <div className="input-header">
                    <label htmlFor="username">USUARIO</label>
                  </div>
                  <div className="input-wrapper">
                    <LuUser className="input-icon" size={16} />
                    <input 
                      type="text" 
                      id="username"
                      value={username} 
                      onChange={e => setUsername(e.target.value)} 
                      required 
                      placeholder="admin" 
                      autoComplete="username" 
                    />
                  </div>
                </div>
                
                <div className="input-group">
                  <div className="input-header">
                    <label htmlFor="password">CONTRASEÑA</label>
                    <a href="#">¿Olvidaste?</a>
                  </div>
                  <div className="input-wrapper">
                    <LuLock className="input-icon" size={16} />
                    <input 
                      type="password" 
                      id="password"
                      value={password} 
                      onChange={e => setPassword(e.target.value)} 
                      required 
                      placeholder="••••••••" 
                      autoComplete="current-password" 
                    />
                  </div>
                </div>
                
                <button type="submit" className="submit-btn" disabled={loading}>
                  {loading ? 'Iniciando Sesion' : 'Iniciar sesión'}
                </button>
              </form>
            
            <div className="auth-links flex flex-col gap-2 auth-links-group">
              <div>
                ¿No tienes una cuenta? <Link to="/register" className="auth-link-highlight">Regístrate aquí</Link>
              </div>
              <div>
                ¿Problemas de conexión? <a href="#">Soporte Técnico</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
