// TeamButton.jsx — Lixbon Team en la barra del IDE: caras del equipo del
// repositorio abierto (se empareja `proyecto.github_repo` con el remoto de
// git), lo pendiente, y los accesos al panel acoplado y a la ventana de Team.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTeamStore } from '../team/store/teamStore';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Avatar } from '../components/Avatar';
import { TeamMark } from '../components/Logo';
import { githubSlug } from '../lib/githubSlug';
import { estadoDef } from '../team/lib/presencia';

export function TeamButton() {
  const { sesion, conexion, proyectos, usuario, noLeidos, error, hidratar, salir, invitar, abrirDirecto } = useTeamStore();
  const { serverUrl, apiKey, user } = useAppStore();
  const remoteUrl = useGitStore((s) => s.remoteUrl);
  const setRightView = useWorkbenchStore((s) => s.setRightView);
  const [open, setOpen] = useState(false);
  const [inviteValue, setInviteValue] = useState('');
  const [inviteMsg, setInviteMsg] = useState('');
  const [manualId, setManualId] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (apiKey) hidratar({ servidor: serverUrl, llave: apiKey, usuario: user });
    else salir();
  }, [apiKey, serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const repoSlug = githubSlug(remoteUrl);
  const matched = useMemo(() => (repoSlug ? proyectos.find((p) => githubSlug(p.github_repo) === repoSlug) : null), [proyectos, repoSlug]);
  const proyecto = proyectos.find((p) => p.id === manualId) || matched || (proyectos.length === 1 ? proyectos[0] : null);
  const miembros = proyecto?.miembros || [];
  const enLinea = miembros.filter((m) => m.estado === 'en_linea').length;
  const pendientes = Object.values(noLeidos).reduce((a, n) => a + n, 0);
  const lider = proyecto?.rol === 'lider';

  const abrirVentana = () => { setOpen(false); invoke('team_abrir').catch(() => {}); };
  const abrirPanel = () => { setOpen(false); setRightView('team'); };
  const escribirA = async (usuarioId) => {
    setOpen(false);
    setRightView('team');
    await abrirDirecto(usuarioId);
  };
  const handleInvite = async () => {
    setInviteMsg('');
    const fallo = await invitar(proyecto.id, inviteValue.trim());
    setInviteMsg(fallo || 'Ya está en el proyecto.');
    if (!fallo) setInviteValue('');
  };

  if (!apiKey) return null;

  return (
    <div className="team" ref={rootRef}>
      <button className={`team__btn ${open ? 'is-open' : ''}`} onClick={() => setOpen((v) => !v)} title="Lixbon Team">
        <span className="team__stack">
          {miembros.slice(0, 3).map((m, i, arr) => (
            <span key={m.usuario.id} className="team__stack-item">
              <Avatar user={m.usuario} serverUrl={serverUrl} size={20} className="team__stack-avatar" />
              {i === arr.length - 1 && enLinea > 0 && <span className="team__stack-dot" />}
            </span>
          ))}
          {miembros.length === 0 && <TeamMark size={16} />}
        </span>
        <span className="team__label">{proyecto ? proyecto.nombre : 'Team'}</span>
        {pendientes > 0 && <span className="team__badge mono">{pendientes > 99 ? '99+' : pendientes}</span>}
      </button>

      {open && (
        <div className="team__menu">
          <div className="team__menu-head">
            <span className="team__menu-title"><TeamMark size={15} />{proyecto ? proyecto.nombre : 'Lixbon Team'}</span>
            <span className={`team__conn ${conexion === 'conectado' ? 'is-on' : ''}`}>
              {sesion === 'error' ? 'Sin conexión' : conexion === 'conectado' ? `${enLinea} en línea` : 'Conectando…'}
            </span>
          </div>
          {error && <p className="account__error">{error}</p>}

          {!proyecto && proyectos.length > 1 && (
            <div className="team__projects">
              {proyectos.map((p) => (
                <button key={p.id} className="ctx-menu__item" onClick={() => setManualId(p.id)}>
                  <span className="menubar__item-label">{p.nombre}</span>
                </button>
              ))}
            </div>
          )}
          {!proyectos.length && sesion === 'ok' && (
            <p className="settings__hint" style={{ padding: '0 4px 8px' }}>Todavía no estás en ningún proyecto. Créalo desde Lixbon Team.</p>
          )}

          {proyecto && (
            <div className="team__members">
              {miembros.map((m) => {
                const soyYo = m.usuario.id === usuario?.id;
                return (
                  <button
                    type="button"
                    className="team__member"
                    key={m.usuario.id}
                    onClick={() => escribirA(m.usuario.id)}
                    disabled={soyYo}
                    title={soyYo ? 'Eres tú' : `Escribirle a ${m.usuario.first_name || m.usuario.username}`}
                  >
                    <span className="team__member-avatar">
                      <Avatar user={m.usuario} serverUrl={serverUrl} size={28} />
                      <span className="team__dot" style={{ background: estadoDef(m.estado).color }} />
                    </span>
                    <div className="team__member-id">
                      <span className="team__member-name">{[m.usuario.first_name, m.usuario.last_name].filter(Boolean).join(' ') || m.usuario.username}{soyYo ? ' (tú)' : ''}</span>
                      <span className="team__member-status">{estadoDef(m.estado).label}{m.rol === 'lider' ? ' · Líder' : ''}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {proyecto && lider && (
            <>
              <div className="ctx-menu__sep" />
              <div className="team__invite">
                <input
                  className="settings__input"
                  placeholder="Correo o usuario a invitar"
                  value={inviteValue}
                  onChange={(e) => { setInviteValue(e.target.value); setInviteMsg(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && inviteValue.trim()) handleInvite(); }}
                  spellCheck={false}
                />
                <button className="pill-btn pill-btn--primary" onClick={handleInvite} disabled={!inviteValue.trim()}>Invitar</button>
              </div>
              {inviteMsg && <p className="settings__status">{inviteMsg}</p>}
            </>
          )}

          <div className="ctx-menu__sep" />
          <button className="ctx-menu__item" onClick={abrirPanel}>
            <span className="menubar__item-label">Abrir en el panel derecho</span>
          </button>
          <button className="ctx-menu__item" onClick={abrirVentana}>
            <span className="menubar__item-label">Abrir Lixbon Team</span>
          </button>
        </div>
      )}
    </div>
  );
}
