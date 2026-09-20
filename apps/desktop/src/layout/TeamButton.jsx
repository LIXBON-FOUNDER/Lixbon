// TeamButton.jsx — botón "Lixbon Team" de la TitleBar: pila de avatares +
// desplegable con presencia en vivo del equipo DEL REPOSITORIO ABIERTO (se
// empareja por `proyecto.github_repo` contra el remoto de git). Un clic en un
// miembro abre un chat directo real; "Abrir Lixbon Team" lleva al hub
// completo (proyectos, canales, directos y amigos).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { Avatar } from '../components/Avatar';
import { IconUser } from '../components/Icons';
import { githubSlug } from '../lib/githubSlug';

const ESTADO_LABEL = {
  en_linea: 'En línea',
  no_molestar: 'No molestar',
  desconectado: 'Desconectado',
};

export function TeamButton() {
  const {
    bootstrapped, connected, proyectos, me, error, inviting,
    bootstrap, invite, abrirDirecto,
  } = useTeamStore();
  const serverUrl = useAppStore((s) => s.serverUrl);
  const openModal = useAppStore((s) => s.openModal);
  const remoteUrl = useGitStore((s) => s.remoteUrl);

  const [open, setOpen] = useState(false);
  const [inviteValue, setInviteValue] = useState('');
  const [inviteMsg, setInviteMsg] = useState('');
  const [manualId, setManualId] = useState(null);
  const [dmBusyId, setDmBusyId] = useState(null);
  const [dmError, setDmError] = useState('');
  const rootRef = useRef(null);

  useEffect(() => {
    if (!bootstrapped) bootstrap();
  }, [bootstrapped, bootstrap]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // El repo abierto manda: si algún proyecto tiene el mismo github_repo que el
  // remoto `origin`, es ese el que se pinta — no "el primero de la lista".
  const repoSlug = githubSlug(remoteUrl);
  const matched = useMemo(
    () => (repoSlug ? proyectos.find((p) => githubSlug(p.github_repo) === repoSlug) : null),
    [proyectos, repoSlug],
  );
  const elegido = proyectos.find((p) => p.id === manualId) || null;
  const proyecto = elegido || matched || (proyectos.length === 1 ? proyectos[0] : null);
  const necesitaElegir = !proyecto && proyectos.length > 1;

  const miembros = proyecto?.miembros || [];
  const enLinea = miembros.filter((m) => m.estado === 'en_linea').length;

  const handleInvite = async () => {
    setInviteMsg('');
    const res = await invite(inviteValue, proyecto?.id);
    if (res.ok) {
      setInviteValue('');
      setInviteMsg('Invitación enviada.');
    } else {
      setInviteMsg(res.error);
    }
  };

  const handleMemberClick = async (usuarioId) => {
    if (!usuarioId || usuarioId === me?.id || dmBusyId) return;
    setDmError('');
    setDmBusyId(usuarioId);
    const res = await abrirDirecto(usuarioId);
    setDmBusyId(null);
    if (res.ok) {
      setOpen(false);
      openModal('dm', res.canal.id);
    } else {
      setDmError(res.error);
    }
  };

  return (
    <div className="team" ref={rootRef}>
      <button
        className={`team__btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Lixbon Team"
      >
        <span className="team__stack">
          {miembros.slice(0, 3).map((m, i, arr) => (
            <span key={m.usuario.id} className="team__stack-item">
              <Avatar user={m.usuario} serverUrl={serverUrl} size={20} className="team__stack-avatar" />
              {i === arr.length - 1 && enLinea > 0 && <span className="team__stack-dot" />}
            </span>
          ))}
          {miembros.length === 0 && <IconUser size={14} />}
        </span>
        <span className="team__label">
          {proyecto ? `${proyecto.nombre}` : 'Team'}
          {connected && miembros.length > 0 && ` · ${enLinea} en línea`}
        </span>
      </button>

      {open && (
        <>
          <div className="team__menu">
            <div className="team__menu-head">
              <span className="team__menu-title">{proyecto ? proyecto.nombre : 'Lixbon Team'}</span>
              <span className={`team__conn ${connected ? 'is-on' : ''}`}>
                {connected ? 'En vivo' : 'Conectando…'}
              </span>
            </div>

            {error && <p className="account__error">{error}</p>}
            {dmError && <p className="account__error">{dmError}</p>}

            {necesitaElegir && (
              <div className="team__projects">
                {proyectos.map((p) => (
                  <button key={p.id} className="ctx-menu__item" onClick={() => setManualId(p.id)}>
                    <span className="menubar__item-label">{p.nombre}</span>
                  </button>
                ))}
              </div>
            )}

            {!proyecto && !necesitaElegir ? (
              <p className="settings__hint" style={{ padding: '0 4px 8px' }}>
                Todavía no tienes ningún proyecto de equipo. Invita a alguien para crear uno.
              </p>
            ) : proyecto ? (
              <div className="team__members">
                {miembros.map((m) => (
                  <button
                    type="button"
                    className="team__member"
                    key={m.usuario.id}
                    onClick={() => handleMemberClick(m.usuario.id)}
                    disabled={m.usuario.id === me?.id || dmBusyId === m.usuario.id}
                    title={m.usuario.id === me?.id ? 'Eres tú' : `Escribirle a ${m.usuario.username}`}
                  >
                    <span className="team__member-avatar">
                      <Avatar user={m.usuario} serverUrl={serverUrl} size={28} />
                      <span className={`team__dot is-${m.estado}`} />
                    </span>
                    <div className="team__member-id">
                      <span className="team__member-name">
                        {[m.usuario.first_name, m.usuario.last_name].filter(Boolean).join(' ') || m.usuario.username}
                      </span>
                      <span className="team__member-status">
                        {dmBusyId === m.usuario.id ? 'Abriendo chat…' : (ESTADO_LABEL[m.estado] || m.estado)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            {proyecto && (
              <>
                <div className="ctx-menu__sep" />
                <div className="team__invite">
                  <input
                    className="settings__input"
                    placeholder="Correo o usuario a invitar"
                    value={inviteValue}
                    onChange={(e) => { setInviteValue(e.target.value); setInviteMsg(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
                    spellCheck={false}
                  />
                  <button
                    className="pill-btn pill-btn--primary"
                    onClick={handleInvite}
                    disabled={inviting || !inviteValue.trim()}
                  >
                    Invitar
                  </button>
                </div>
                {inviteMsg && <p className="settings__status">{inviteMsg}</p>}
              </>
            )}

            <div className="ctx-menu__sep" />
            <button className="ctx-menu__item" onClick={() => { setOpen(false); openModal('team'); }}>
              <span className="menubar__item-label">Abrir Lixbon Team</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
