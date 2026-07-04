import React from 'react';
import { LuBlocks, LuTerminal, LuWorkflow, LuCode } from 'react-icons/lu';
import '../../style/Integrations.css';

export default function Integrations() {
  return (
    <div id="integrations" className="section-content active">
      <section className="panel">
        <h2><LuBlocks className="integrations-icon" /> Integraciones API</h2>
        <p className="muted">
          El Gateway es 100% compatible con el formato de API de OpenAI.
        </p>

        <div className="integration-grid integrations-grid">
          <article className="quick-card integrations-card">
            <h3>
              <LuTerminal className="integrations-card-title-icon" /> 
              curl (Terminal)
            </h3>
            <pre className="integrations-pre">
<code>{`curl -X POST "http://IP_SERVIDOR:8000/v1/chat/completions" \\
  -H "Authorization: Bearer TU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model":"llama3.1:8b",
    "messages":[{"role":"user","content":"Hola"}],
    "client_id":"pc-diseno-01"
  }'`}</code>
            </pre>
          </article>

          <article className="quick-card integrations-card">
            <h3>
              <LuWorkflow className="integrations-card-title-icon" /> 
              n8n / Make
            </h3>
            <ul className="integrations-list">
              <li><strong>Nodo:</strong> OpenAI Chat Model</li>
              <li><strong>Base URL:</strong> <code>http://IP_SERVIDOR:8000/v1</code></li>
              <li><strong>API Key:</strong> Generada en este panel</li>
              <li><strong>Model:</strong> El nombre exacto de Ollama (ej: <code>llama3.1:8b</code>)</li>
            </ul>
          </article>

          <article className="quick-card integrations-card-full">
            <h3>
              <LuCode className="integrations-card-title-icon" /> 
              Node.js / Python SDK
            </h3>
            <ul className="integrations-list">
              <li>Instancia el cliente oficial de OpenAI en tu código.</li>
              <li>Cambia <code>baseURL</code> apuntando al puerto 8000 del servidor.</li>
              <li>Añade el header <code>client_id</code> si deseas separar las métricas por aplicación o equipo.</li>
            </ul>
          </article>
        </div>
      </section>
    </div>
  );
}
