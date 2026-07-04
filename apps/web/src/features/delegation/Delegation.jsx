import React, { useState } from 'react';
import { api } from '../../lib/api';
import { LuSparkles, LuBrainCircuit } from 'react-icons/lu';
import '../../style/Delegation.css';

export default function Delegation() {
  const [userInput, setUserInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!userInput.trim()) return;

    setLoading(true);
    setResult({
      status: 'Procesando... (embedding → clasificación → enrutamiento → ejecución)'
    });

    try {
      const res = await api.post('/api/delegate', { user_input: userInput });
      setResult(res.data);
    } catch (err) {
      setResult({
        error: err.response?.data?.detail || err.message || 'Error al conectar con el servidor'
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div id="delegate" className="section-content active">
      <section className="panel delegation-panel">
        <h2><LuSparkles className="delegation-icon" /> Delegación Inteligente</h2>
        <p className="muted">
          Escribe tu solicitud en lenguaje natural. El sistema la clasifica automáticamente, busca
          contexto similar en tu historial y la delega al modelo Ollama más adecuado.
        </p>

        <form onSubmit={handleSubmit} className="delegation-form">
          <label htmlFor="delegate-input">¿Qué necesitas hacer?</label>
          <textarea 
            id="delegate-input" 
            rows="3" 
            required
            placeholder="Ej: Necesito desplegar mi app, mi API devuelve error 500, ¿cómo configuro variables de entorno?..."
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
          ></textarea>
          <button type="submit" disabled={loading}>
            <LuBrainCircuit className="delegation-btn-icon" /> 
            {loading ? 'Delegando...' : 'Delegar solicitud'}
          </button>
        </form>

        {result && (
          <div id="delegate-result-box" className="delegation-result-box">
            {result.status && (
              <div className="muted small delegation-status">{result.status}</div>
            )}
            
            {result.error && (
              <div className="error-box delegation-error">{result.error}</div>
            )}

            {result.classification && (
              <div className="classification-tags">
                {result.routing?.type && (
                  <span className={`tag tag-router-${result.routing.type}`}>
                    {result.routing.type}
                  </span>
                )}
                {result.classification.intent && (
                  <span className="tag">intent: {result.classification.intent}</span>
                )}
                {result.classification.complexity != null && (
                  <span className="tag">complejidad: {result.classification.complexity}</span>
                )}
                {result.classification.domain && (
                  <span className="tag">dominio: {result.classification.domain}</span>
                )}
                {result.classification.riskLevel && (
                  <span className="tag">riesgo: {result.classification.riskLevel}</span>
                )}
                {result.routing?.model && (
                  <span className="tag">modelo: {result.routing.model}</span>
                )}
              </div>
            )}

            {result.response && (
              <div className="delegate-result delegation-response">
                {result.response}
              </div>
            )}

            {result.execution_time_ms != null && (
              <p className="small muted delegation-time">
                Tiempo: {result.execution_time_ms} ms
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
