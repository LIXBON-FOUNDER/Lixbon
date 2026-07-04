import React from 'react';
import { useAppStore } from '../../store/appStore';
import { LuCpu, LuCheck } from 'react-icons/lu';

export function ModelList() {
  const { availableModels, currentModel, setCurrentModel } = useAppStore();

  return (
    <div className="models-card">
      <div className="card-header flex align-center gap-2">
        <LuCpu size={16} className="header-icon" />
        <h3>MODELOS DE INTELIGENCIA ARTIFICIAL DISPONIBLES</h3>
      </div>

      <div className="models-grid">
        {availableModels.length === 0 ? (
          <div className="empty-models font-mono">[NO ACTIVE MODELS DETECTED IN OLLAMA ENGINE]</div>
        ) : (
          availableModels.map((model) => {
            const isActive = currentModel === model.id;
            // Parsear tamaño aproximado
            const sizeGB = model.size ? (model.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : 'Tamaño N/A';
            const family = model.details?.family || 'N/A';
            const format = model.details?.parameter_size || 'N/A';

            return (
              <div 
                key={model.id} 
                onClick={() => setCurrentModel(model.id)}
                className={`model-item-card flex justify-between align-center ${isActive ? 'active' : ''}`}
              >
                <div className="flex flex-col">
                  <span className="model-name font-mono">{model.id}</span>
                  <span className="model-meta">Formato: {format} · Familia: {family}</span>
                </div>

                <div className="flex align-center gap-2">
                  <span className="model-size font-mono">{sizeGB}</span>
                  {isActive && (
                    <div className="active-badge flex align-center justify-center">
                      <LuCheck size={12} />
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .models-card {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          margin-top: 24px;
        }
        .card-header {
          margin-bottom: 16px;
        }
        .card-header h3 {
          font-size: 0.9rem;
          font-weight: 700;
          color: #fff;
          letter-spacing: 0.05em;
        }
        .header-icon {
          color: var(--accent);
        }
        .models-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
        }
        @media (min-width: 768px) {
          .models-grid {
            grid-template-columns: 1fr 1fr;
          }
        }
        .model-item-card {
          background-color: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 14px 16px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .model-item-card:hover {
          border-color: var(--border-focus);
        }
        .model-item-card.active {
          border-color: var(--accent);
          background-color: rgba(var(--accent-rgb), 0.05);
          box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.1);
        }
        .model-name {
          font-size: 0.85rem;
          font-weight: 700;
          color: #fff;
        }
        .light-theme .model-name {
          color: var(--text-primary);
        }
        .model-meta {
          font-size: 0.7rem;
          color: var(--text-secondary);
          margin-top: 2px;
        }
        .model-size {
          font-size: 0.75rem;
          color: var(--text-muted);
        }
        .active-badge {
          background-color: var(--accent);
          color: #fff;
          width: 18px;
          height: 18px;
          border-radius: 50%;
        }
        .empty-models {
          grid-column: 1 / -1;
          color: var(--text-muted);
          text-align: center;
          padding: 20px;
          font-size: 0.8rem;
        }
      `}} />
    </div>
  );
}
