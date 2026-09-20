// HistoryList.jsx — "Recientes": conversaciones del workspace, siempre
// visibles bajo el nav de Chat en el sidebar (buscar, abrir, renombrar, borrar).
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useChatStore } from '../store/chatStore';
import { IconPencil, IconTrash, IconSearch } from '../components/Icons';

function relTime(iso) {
  if (!iso) return '';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'ahora';
  if (secs < 3600) return `hace ${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `hace ${Math.floor(secs / 3600)} h`;
  if (secs < 86400 * 30) return `hace ${Math.floor(secs / 86400)} d`;
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

export function HistoryList() {
  const { loadConversation, conversationId } = useChatStore();
  const [items, setItems] = useState(null); // null = cargando
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
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
    <div className="recent">
      <div className="sidebar__section-head">
        <span>Recientes</span>
        <button
          className="iconbtn"
          onClick={() => setSearchOpen((v) => !v)}
          title="Buscar conversaciones"
        >
          <IconSearch size={12} />
        </button>
      </div>

      {searchOpen && (
        <div className="recent__search">
          <IconSearch size={12} />
          <input
            type="text"
            placeholder="Buscar…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      )}

      <div className="recent__list">
        {items === null ? (
          <>
            <span className="skeleton recent__skeleton" />
            <span className="skeleton recent__skeleton" />
            <span className="skeleton recent__skeleton" />
          </>
        ) : items.length === 0 ? (
          <p className="recent__empty">
            {query ? 'Sin resultados.' : 'Aún no tienes conversaciones.'}
          </p>
        ) : (
          items.map((c) => (
            <div key={c.id} className={`recent__item ${c.id === conversationId ? 'is-active' : ''}`}>
              {renamingId === c.id ? (
                <input
                  className="recent__rename"
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
                <button className="subitem recent__btn" onClick={() => handleOpen(c.id)} title={c.title}>
                  <span className="recent__title">{c.title || 'Sin título'}</span>
                  <span className="recent__time">{relTime(c.updated_at)}</span>
                </button>
              )}
              <span className="recent__actions">
                <button
                  title="Renombrar"
                  onClick={() => { setRenamingId(c.id); setRenameValue(c.title || ''); }}
                >
                  <IconPencil size={12} />
                </button>
                <button title="Eliminar" onClick={() => handleDelete(c.id, c.title)}>
                  <IconTrash size={12} />
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
