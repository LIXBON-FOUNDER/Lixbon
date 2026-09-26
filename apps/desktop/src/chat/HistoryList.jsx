// HistoryList.jsx — conversaciones del IDE agrupadas por fecha, con la que
// está en curso arriba: buscar, abrir, renombrar y borrar.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { showConfirm } from '../lib/confirm';
import { useChatStore, useOpenSessions, useSessionsStore, spawnSessionOf } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { claudeSessions } from '../lib/claudeCode';
import { ClaudeMark } from '../components/Logo';
import { SpinRing } from '../components/Ring';
import { IconPencil, IconTrash, IconSearch } from '../components/Icons';

function relTime(iso) {
  if (!iso) return '';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'ahora';
  if (secs < 3600) return `${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h`;
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

function groupOf(iso) {
  const d = new Date(iso || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  if (diff < 7) return 'Esta semana';
  return 'Anteriores';
}

export function HistoryList() {
  const { loadConversation, conversationId, conversationTitle, streaming } = useChatStore();
  const [items, setItems] = useState(null);
  const [ccItems, setCcItems] = useState([]);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const open = useOpenSessions();
  const running = open.filter((o) => o.streaming || o.waiting || (!o.active && !o.seen && o.hasMessages));
  const runningKey = running.map((o) => `${o.key}:${o.streaming}:${o.conversationId}`).join('|');

  const fetchList = async (q = '') => {
    try {
      const res = await api.get(`/api/conversations?source=ide&limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      setItems(res.conversations || []);
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => fetchList(query.trim()), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, conversationId, conversationTitle, streaming, runningKey]);

  useEffect(() => {
    if (!workspaceRoot) { setCcItems([]); return; }
    claudeSessions(workspaceRoot)
      .then((list) => setCcItems(list.map((s) => ({ id: s.id, title: s.title, updated_at: new Date(s.updated_ms).toISOString(), engine: 'claude' }))))
      .catch(() => setCcItems([]));
  }, [workspaceRoot, conversationId, streaming, runningKey]);

  const groups = useMemo(() => {
    const out = [];
    const liveIds = new Set(running.map((o) => o.conversationId).filter(Boolean));
    if (running.length) {
      out.push({
        label: running.length > 1 ? `En curso · ${running.length} agentes` : 'En curso',
        items: running.map((o) => ({ id: o.conversationId || o.key, key: o.key, title: o.title, live: true, streaming: o.streaming, waiting: o.waiting })),
      });
    }
    const q = query.trim().toLowerCase();
    const all = [...(items || []), ...ccItems.filter((c) => !q || c.title.toLowerCase().includes(q))]
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    for (const c of all) {
      if (liveIds.has(c.id)) continue;
      const label = groupOf(c.updated_at);
      const g = out.find((x) => x.label === label) || (out.push({ label, items: [] }), out[out.length - 1]);
      g.items.push(c);
    }
    return out;
  }, [items, ccItems, runningKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const openItem = async (c) => {
    if (c.live) { useSessionsStore.getState().activate(c.key); return; }
    setError('');
    const id = c.id;
    try {
      const cur = useChatStore.getState();
      const same = (cur.engine || 'lixbon') === (c.engine || 'lixbon');
      if (same) await loadConversation(id);
      else await spawnSessionOf(c.engine || 'lixbon').getState().loadConversation(id);
    } catch (e) { setError(`No se pudo abrir: ${e.message || e}`); }
  };

  const rename = async (id) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await api.patch(`/api/conversations/${id}`, { title });
      setItems((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    } catch (e) {
      setError(`No se pudo renombrar: ${e.message}`);
    }
  };

  const remove = async (id, title) => {
    const { choice } = await showConfirm({
      title: 'Eliminar conversación',
      message: `«${title || 'Sin título'}» se borrará para siempre, también en la web y el móvil.`,
      options: [{ id: 'yes', label: 'Eliminar', kind: 'danger' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'yes') return;
    try {
      await api.delete(`/api/conversations/${id}`);
      setItems((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(`No se pudo eliminar: ${e.message}`);
    }
  };

  return (
    <div className="hist">
      <div className="hist__search">
        {searchOpen ? (
          <div className="field drop-in">
            <IconSearch size={12} />
            <input autoFocus value={query} placeholder="Buscar conversaciones" spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />
          </div>
        ) : (
          <button className="lk hist__searchbtn" onClick={() => setSearchOpen(true)}><IconSearch size={12} /> Buscar</button>
        )}
      </div>
      {error && <span className="hist__error">{error}</span>}

      <div className="hist__list scroll">
        {items === null && [0, 1, 2].map((i) => <span key={i} className="skeleton hist__skeleton" />)}
        {items && groups.length === 0 && <span className="hist__empty">{query ? 'Sin resultados.' : 'Aún no tienes conversaciones.'}</span>}
        {groups.map((g) => (
          <section key={g.label} className="hist__group">
            <span className="hist__label">{g.label}</span>
            {g.items.map((c, i) => (
              <div key={c.key || c.id} className={`hist__item ${(c.key ? open.find((o) => o.key === c.key)?.active : c.id === conversationId) ? 'is-active' : ''}`} style={{ animationDelay: `${Math.min(i, 10) * 20}ms` }}>
                {renamingId === c.id ? (
                  <input
                    className="hist__rename"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => rename(c.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') rename(c.id); if (e.key === 'Escape') setRenamingId(null); }}
                  />
                ) : (
                  <button className="hist__btn" onClick={() => openItem(c)} title={c.title}>
                    {c.streaming && !c.waiting && <SpinRing size={11} />}
                    {c.waiting && <span className="dot dot--accent dot--pulse" title="Espera tu permiso" />}
                    {c.live && !c.streaming && !c.waiting && <span className="dot dot--good" title="Terminó" />}
                    {(c.engine === 'claude' || open.find((o) => o.key === c.key)?.engine === 'claude') && <ClaudeMark size={11} />}
                    <span className="hist__title">{c.title || 'Nueva conversación'}</span>
                    <span className="hist__time">{c.waiting ? 'permiso' : c.streaming ? 'ahora' : c.live ? 'listo' : relTime(c.updated_at)}</span>
                  </button>
                )}
                {!c.live && c.engine !== 'claude' && renamingId !== c.id && (
                  <span className="hist__acts">
                    <button className="ic" title="Renombrar" onClick={() => { setRenamingId(c.id); setRenameValue(c.title || ''); }}><IconPencil size={12} /></button>
                    <button className="ic" title="Eliminar" onClick={() => remove(c.id, c.title)}><IconTrash size={12} /></button>
                  </span>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
