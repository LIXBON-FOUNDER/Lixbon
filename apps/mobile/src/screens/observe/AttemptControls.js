import React, { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useDialogs } from '../../components/dialogs';
import { Eyebrow, PillButton, useColors } from '../../components/ui';
import { CONTROLS_ACTION, controlReady, controlOutcome, recoverQueue } from '../../observe/controls';
import { usePrivateView } from '../../observe/usePrivateView';
import { Body, Mono, Notice } from '../../observe/ui';

const messages = {
  queued: 'El Core confirmó la instrucción en la cola.', cancelled: 'El Core confirmó la cancelación del elemento.',
  stopped: 'El Core confirmó el intento detenido.', stale_attempt: 'Este ya no es el intento actual. Abre el intento actual para controlarlo.',
  stale_queue: 'El elemento cambió o pertenece a otro intento.', not_running: 'El intento ya no está ejecutándose.',
  policy_denied: 'La policy impide esta acción desde Mobile.', policy_out_of_band_required: 'La policy requiere confirmación fuera de banda en Desktop.',
  unsupported_capability: 'El proveedor no admite este control.', queue_unsupported: 'El proveedor no puede reanudar para entregar Queue.',
  desktop_required: 'Este intento requiere control desde Desktop.', attempt_stop_unavailable: 'No se pudo confirmar el Stop. Consulta el estado antes de repetir.',
  unconfirmed: 'No llegó confirmación del Core. Consulta el estado. No se repetirá nada automáticamente.',
  timeout: 'Se agotó la espera. El resultado sigue sin confirmar; consulta el estado.',
};
const labels = { queued: 'En cola', delivering: 'Entregando', delivered: 'Entregado', cancelled: 'Cancelado', failed: 'Falló' };

export default function AttemptControls({ obs, attemptId }) {
  const colors = useColors();
  const { confirm } = useDialogs();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(null);
  const [status, setStatus] = useState(null);
  const lock = useRef(false);
  const view = usePrivateView(obs, CONTROLS_ACTION, { attempt_id: attemptId, ...(pending ? { request_id: pending.request_id } : {}) });
  const data = view.data;
  const fresh = view.online && view.fresh && data?.attempt_id === attemptId;
  useEffect(() => {
    if (!fresh || !pending) return;
    const recovered = recoverQueue(data, pending);
    if (recovered) {
      setStatus(recovered === 'failed' ? 'La instrucción figura como fallida en el Core.' : `El Core encontró la solicitud: ${labels[recovered]}.`);
      setPending(null); setDraft('');
    }
  }, [data, fresh, pending]);
  const perform = async (operation) => {
    if (!fresh || lock.current) return;
    const kind = operation.kind;
    if (kind !== 'cancel' && !controlReady(data, attemptId, kind)) return;
    if (kind === 'cancel' && !data.queue?.items?.some((item) => item.queue_id === operation.queue_id && item.status === 'queued')) return;
    lock.current = true; setBusy(kind);
    const generation = view.current.current.generation;
    try {
      const accepted = await confirm({ title: kind === 'stop' ? '¿Detener este intento?' : kind === 'cancel' ? '¿Cancelar esta instrucción?' : '¿Encolar esta instrucción?',
        message: `Tarea ${data.task_id}\nIntento ${attemptId}${kind === 'queue' ? `\n\n${operation.body}` : kind === 'cancel' ? `\nElemento ${operation.queue_id}` : ''}`,
        confirmLabel: kind === 'stop' ? 'Detener intento' : kind === 'cancel' ? 'Cancelar instrucción' : 'Encolar instrucción', danger: kind === 'stop' });
      if (!accepted || !view.current.current.online || !view.current.current.fresh || generation !== view.current.current.generation) return;
      if (kind === 'queue') setPending({ request_id: operation.request_id, body: operation.body });
      setStatus(null);
      const result = await obs.request(CONTROLS_ACTION, { attempt_id: attemptId, operation: { ...operation, confirm: true } });
      const outcome = controlOutcome(result, attemptId, operation);
      setStatus(outcome);
      if (kind === 'queue' && outcome === 'queued') { setPending(null); setDraft(''); }
      view.invalidate(); view.refresh(); obs.retry();
    } finally { lock.current = false; setBusy(null); }
  };
  if (!view.supported) return null;
  const queueAllowed = fresh && !busy && controlReady(data, attemptId, 'queue');
  const notice = status || view.error;
  return <View style={{ gap: 12 }}>
    <Eyebrow>Controles del intento</Eyebrow>
    <Mono selectable>{`Intento ${attemptId}`}</Mono>
    {data && <Body>{`Estado Core: ${data.status} · Queue: ${data.queue_control?.policy} · Stop: ${data.stop_control?.policy}`}</Body>}
    {!view.online && <Notice>Sin conexión. No se enviarán comandos. El borrador permanece en esta pantalla.</Notice>}
    {busy && <Notice>{busy === 'stop' ? 'Deteniendo… esperando al Core.' : 'Enviando… esperando al Core.'}</Notice>}
    {notice && <Notice>{messages[notice] || (String(notice).startsWith('El Core') || String(notice).startsWith('La instrucción') ? notice : 'El Core no confirmó la operación. Actualiza su estado.')}</Notice>}
    {data?.queue_control?.reason && <Body muted>{messages[data.queue_control.reason] || 'Queue no está disponible en este estado.'}</Body>}
    {data?.stop_control?.reason && data.stop_control.reason !== data.queue_control?.reason && <Body muted>{messages[data.stop_control.reason] || 'Stop no está disponible en este estado.'}</Body>}
    <TextInput accessibilityLabel="Instrucción para la cola" multiline maxLength={4000} editable={!busy && !pending}
      value={pending?.body ?? draft} onChangeText={setDraft} placeholder="Instrucción para el siguiente turno"
      placeholderTextColor={colors.inkMuted} style={{ minHeight: 88, padding: 12, fontSize: 16, textAlignVertical: 'top', color: colors.ink, backgroundColor: colors.surface2 }} />
    <PillButton label={pending ? 'Reintentar misma solicitud' : 'Encolar instrucción'} style={{ minHeight: 48 }} disabled={!queueAllowed || !(pending?.body ?? draft).trim()}
      onPress={() => perform({ kind: 'queue', request_id: pending?.request_id || Crypto.randomUUID(), body: pending?.body ?? draft.trim() })} />
    {pending && <Notice>Solicitud sin confirmar. Un reintento usa el mismo identificador y texto. Reconectar solo consulta su estado.</Notice>}
    <Eyebrow>{`Cola pendiente · ${data?.queue?.pending_total ?? '…'}`}</Eyebrow>
    {data?.queue?.items?.map((item) => <View key={item.queue_id} style={{ gap: 5 }}>
      <Body>{`${item.position ?? item.seq}. ${item.body}${item.body_truncated ? '…' : ''} · ${labels[item.status] || item.status}`}</Body>
      {item.status === 'queued' && <PillButton outline label={`Cancelar instrucción ${item.position ?? item.seq}`} style={{ minHeight: 48 }} disabled={!fresh || !!busy} onPress={() => perform({ kind: 'cancel', queue_id: item.queue_id })} />}
    </View>)}
    {data?.queue?.mobile_truncated && <Body muted>Mostrando los primeros 30 elementos. Consulta el resto en Desktop.</Body>}
    {data?.queue?.finished?.map((item) => <Body key={item.queue_id}>{`${labels[item.status] || item.status}: ${item.body}${item.body_truncated ? '…' : ''}${item.failure ? ` · ${item.failure}` : ''}`}</Body>)}
    <PillButton outline label="Detener intento" style={{ minHeight: 48 }} disabled={!fresh || !!busy || !controlReady(data, attemptId, 'stop')} onPress={() => perform({ kind: 'stop' })} />
    <PillButton outline label="Actualizar controles" style={{ minHeight: 48 }} disabled={!view.online || !!busy} onPress={view.refresh} />
  </View>;
}
