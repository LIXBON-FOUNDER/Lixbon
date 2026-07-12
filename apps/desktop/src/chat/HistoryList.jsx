// HistoryList.jsx — historial de conversaciones (buscar, abrir, renombrar, borrar).
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useChatStore } from '../store/chatStore';
import { IconPencil, IconTrash, IconSearch } from '../components/Icons';

export function HistoryList() {
  const { loadConversation } = useChatStore();
  const [items, setItems] = useState(null); // null = cargando
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const fetchList = async (q = '') => {
    try {
      const res = await api.get(`/api/conversations?source=ide&limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      setItems(res.conversations || []);
    } catch (e) {
      console.error('[history] Error cargando historial:', e);
      setItems([]);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => fetchList(query.trim()), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query]);

  const handleOpen = async (id) => {
    try {
      await loadConversation(id);
    } catch (e) {
      alert('No se pudo cargar la conversación: ' + e.message);
    }
  };

  const handleRename = async (id) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await api.patch(`/api/conversations/${id}`, { title });
      setItems((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    } catch (e) {
      alert('No se pudo renombrar: ' + e.message);
    }
  };

  const handleDelete = async (id, title) => {
    if (!window.confirm(`¿Eliminar "${title || 'esta conversación'}"? No se puede deshacer.`)) return;
    try {
      await api.delete(`/api/conversations/${id}`);
      setItems((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      alert('No se pudo eliminar: ' + e.message);
    }
  };

  return (
    <div className="history">
      <div className="history__search">
        <IconSearch size={14} />
        <input
          type="text"
          placeholder="Buscar conversaciones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="history__list">
        {items === null ? (
          <>
            <span className="skeleton history__skeleton" />
            <span className="skeleton history__skeleton" />
            <span className="skeleton history__skeleton" />
          </>
        ) : items.length === 0 ? (
          <p className="history__empty">
            {query ? 'Sin resultados para esa búsqueda.' : 'Aún no tienes conversaciones.'}
          </p>
        ) : (
          items.map((c) => (
            <div key={c.id} className="history__item">
              {renamingId === c.id ? (
                <input
                  className="history__rename"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => handleRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(c.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  autoFocus
                />
              ) : (
                <button className="history__title" onClick={() => handleOpen(c.id)} title={c.title}>
                  {c.title || 'Sin título'}
                </button>
              )}
              <span className="history__actions">
                <button
                  title="Renombrar"
                  onClick={() => { setRenamingId(c.id); setRenameValue(c.title || ''); }}
                >
                  <IconPencil size={13} />
                </button>
                <button title="Eliminar" onClick={() => handleDelete(c.id, c.title)}>
                  <IconTrash size={13} />
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
