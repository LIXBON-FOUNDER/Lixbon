import React, { useEffect, useRef, useState } from 'react';
import { Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { PillButton } from '../../components/ui';
import { Body, Mono, Notice } from '../../observe/ui';
import { createDesktopLinkController, preparedDesktopLink, DESKTOP_LINK_CAPABILITY, DESKTOP_LINK_MESSAGES } from '../../observe/desktopLink';

export default function OpenOnDesktop({ obs, target }) {
  const [link, setLink] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([obs.session?.id, target]);
  const seq = useRef(0);
  const lock = useRef(false);
  const available = obs.capabilities?.includes(DESKTOP_LINK_CAPABILITY) === true;
  const online = obs.view.kind === 'online';
  useEffect(() => {
    ++seq.current; lock.current = false; setLink(null); setStatus(null); setBusy(false);
    return () => { ++seq.current; };
  }, [key]);
  const open = async () => {
    if (!online || !available || lock.current) return;
    const mine = ++seq.current;
    lock.current = true; setBusy(true); setStatus(null);
    const controller = createDesktopLinkController({ request: obs.request, publish: (state) => {
      if (mine !== seq.current) return;
      setStatus(state.code);
      // Preserve a previously prepared URL across a transport failure, only for this host/target.
      setLink((previous) => preparedDesktopLink(previous, state));
    } });
    try { await controller.prepare(target); }
    catch { if (mine === seq.current) setStatus('offline'); }
    finally { if (mine === seq.current) { lock.current = false; setBusy(false); } }
  };
  const copy = async () => {
    try { await Clipboard.setStringAsync(link.url); setStatus('copied'); }
    catch { setStatus('copy_failed'); }
  };
  const share = async () => {
    try { await Share.share({ title: 'Abrir en Lixbon Desktop', message: link.url }); }
    catch { setStatus('share_failed'); }
  };
  return <View style={{ gap: 8 }}>
    <PillButton outline label={busy ? 'Verificando destino…' : 'Abrir en Desktop'} onPress={open} disabled={busy || !online || !available} style={{ minHeight: 48 }} />
    {!available && <Body muted>Actualiza Desktop para preparar enlaces de este destino.</Body>}
    {!online && <Body muted>{DESKTOP_LINK_MESSAGES.offline}</Body>}
    {link && <>
      <Mono selectable>{link.url}</Mono>
      <PillButton outline label="Copiar enlace de Desktop" onPress={copy} style={{ minHeight: 48 }} />
      <PillButton outline label="Compartir enlace de Desktop" onPress={share} style={{ minHeight: 48 }} />
    </>}
    {status && <Notice>{status === 'copied' ? 'Enlace copiado.' : status === 'copy_failed' ? 'No se pudo copiar. Mantén pulsado el enlace para seleccionarlo.' : status === 'share_failed' ? 'No se pudo compartir. Puedes copiar el enlace.' : DESKTOP_LINK_MESSAGES[status] || 'No se pudo preparar el destino. Actualiza la pantalla y vuelve a intentarlo.'}</Notice>}
  </View>;
}
