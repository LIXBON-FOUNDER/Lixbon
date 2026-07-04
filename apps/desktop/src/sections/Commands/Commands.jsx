import React, { useState } from 'react';
import { CommandCard } from './CommandCard';
import { LuSearch } from 'react-icons/lu';

export function Commands() {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');

  const commandsList = [
    {
      name: '/help',
      syntax: '/help',
      desc: 'Muestra un listado interactivo de comandos disponibles y su sintaxis básica.',
      example: '/help',
      category: 'system'
    },
    {
      name: '/model',
      syntax: '/model [nombre_modelo]',
      desc: 'Muestra el modelo activo o cambia al modelo solicitado si coincide con los cargados en el motor Ollama.',
      example: '/model llama3.2:latest',
      category: 'model'
    },
    {
      name: '/clear',
      syntax: '/clear',
      desc: 'Limpia la pantalla visual del terminal de comandos sin cerrar la sesión de chat activa.',
      example: '/clear',
      category: 'system'
    },
    {
      name: '/info',
      syntax: '/info',
      desc: 'Muestra información detallada sobre el estado actual del clúster y la latencia con la base de datos.',
      example: '/info',
      category: 'system'
    },
    {
      name: 'connect',
      syntax: 'connect --cluster <id> [--verbose]',
      desc: 'Establece conexión SSH/TLS segura con un clúster distribuido de agentes.',
      example: 'connect --cluster 090 --verbose',
      category: 'session'
    },
    {
      name: 'list-models',
      syntax: 'list-models --available',
      desc: 'Lista todos los modelos descargados en el servidor FastAPI local.',
      example: 'list-models --available',
      category: 'model'
    },
    {
      name: 'deploy-agent',
      syntax: 'deploy-agent --name <agente> --model <modelo>',
      desc: 'Despliega un nuevo nodo agente autónomo en caliente dentro de la red.',
      example: 'deploy-agent --name worker-1 --model codellama:34b',
      category: 'session'
    }
  ];

  const filteredCommands = commandsList.filter(cmd => {
    const matchesSearch = cmd.name.toLowerCase().includes(search.toLowerCase()) || 
                          cmd.desc.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = filterCategory === 'all' || cmd.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="commands-page flex-col flex-1">
      <div className="commands-header flex justify-between align-center">
        <h2 className="section-title" style={{ marginBottom: 0 }}>Catálogo de Comandos</h2>
        
        <div className="filter-group flex gap-2">
          {['all', 'system', 'model', 'session'].map(cat => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={`filter-tab ${filterCategory === cat ? 'active' : ''}`}
            >
              {cat.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="search-bar flex align-center gap-2">
        <LuSearch size={18} style={{ color: 'var(--text-secondary)' }} />
        <input
          type="text"
          placeholder="Buscar comandos..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
      </div>

      <div className="commands-grid">
        {filteredCommands.length === 0 ? (
          <div className="no-commands font-mono">[NO MATCHING COMMANDS FOUND IN DATABASE]</div>
        ) : (
          filteredCommands.map((cmd, index) => (
            <CommandCard key={index} {...cmd} />
          ))
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .commands-page {
          overflow-y: auto;
          height: 100%;
        }
        .commands-header {
          margin-bottom: 24px;
        }
        .filter-tab {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--text-secondary);
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s;
          border: 1px solid var(--border);
        }
        .filter-tab.active {
          background-color: var(--bg-secondary);
          border-color: var(--accent);
          color: var(--accent);
        }
        .search-bar {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 12px 16px;
          margin-bottom: 24px;
        }
        .search-input {
          flex: 1;
          font-size: 0.9rem;
          color: #ffffff;
        }
        .light-theme .search-input {
          color: var(--text-primary);
        }
        .search-input::placeholder {
          color: var(--text-muted);
        }
        .commands-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 16px;
        }
        @media (min-width: 768px) {
          .commands-grid {
            grid-template-columns: 1fr 1fr;
          }
        }
        .no-commands {
          grid-column: 1 / -1;
          color: var(--text-muted);
          text-align: center;
          padding: 40px 20px;
          font-size: 0.85rem;
        }
      `}} />
    </div>
  );
}
