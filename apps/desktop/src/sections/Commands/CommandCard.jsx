import React from 'react';

export function CommandCard({ name, syntax, desc, example, category }) {
  let categoryColor = 'var(--text-info)';
  let categoryBg = 'rgba(56, 189, 248, 0.1)';

  if (category === 'model') {
    categoryColor = 'var(--accent)';
    categoryBg = 'rgba(124, 58, 237, 0.1)';
  } else if (category === 'session') {
    categoryColor = 'var(--text-terminal)';
    categoryBg = 'rgba(34, 197, 94, 0.1)';
  } else if (category === 'system') {
    categoryColor = 'var(--accent-alt)';
    categoryBg = 'rgba(59, 130, 246, 0.1)';
  }

  return (
    <div className="command-card flex flex-col gap-2">
      <div className="flex justify-between align-center">
        <span className="cmd-name font-mono">{name}</span>
        <span 
          className="cmd-category font-mono" 
          style={{ color: categoryColor, backgroundColor: categoryBg }}
        >
          {category.toUpperCase()}
        </span>
      </div>
      
      <p className="cmd-desc">{desc}</p>
      
      <div className="cmd-block flex flex-col gap-1 font-mono">
        <div className="cmd-line"><span className="label">SYNTAX:</span> {syntax}</div>
        <div className="cmd-line"><span className="label">EXAMPLE:</span> {example}</div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .command-card {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px 20px;
          transition: border-color 0.2s;
        }
        .command-card:hover {
          border-color: var(--border-focus);
        }
        .cmd-name {
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
        }
        .light-theme .cmd-name {
          color: var(--text-primary);
        }
        .cmd-category {
          font-size: 0.65rem;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 600;
        }
        .cmd-desc {
          font-size: 0.8rem;
          color: var(--text-secondary);
          line-height: 1.4;
        }
        .cmd-block {
          background-color: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 10px;
          font-size: 0.75rem;
          margin-top: 8px;
        }
        .cmd-line {
          color: var(--text-primary);
        }
        .cmd-line .label {
          color: var(--text-muted);
          font-weight: 600;
          margin-right: 4px;
        }
      `}} />
    </div>
  );
}
