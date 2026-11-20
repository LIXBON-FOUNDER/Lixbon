import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useDialogs } from '../../components/dialogs';
import { Eyebrow, PillButton } from '../../components/ui';
import { Body, Mono, Notice, Title } from '../../observe/ui';
import { PROVENANCE, REVIEW_ACTION, reviewOutcome, reviewReady } from '../../observe/review';
import { usePrivateView } from '../../observe/usePrivateView';

const messages = {
  accepted: 'El Core confirmó la aceptación de esta revisión.', rejected: 'El Core confirmó el rechazo. El trabajo se conserva.',
  head_moved: 'La revisión cambió. Revisa el nuevo diff y confirma de nuevo.', stale_review: 'Esta solicitud de revisión dejó de estar activa.',
  desktop_required: 'El diff es demasiado grande o no está completo. Continúa en Desktop.',
  review_unavailable: 'Este intento todavía no se puede revisar.', policy_denied: 'La policy impide decidir desde Mobile.',
  policy_out_of_band_required: 'Esta decisión requiere confirmación fuera de banda en Desktop.',
  unconfirmed: 'No llegó confirmación del Core. Consulta el estado antes de repetir.',
  desktop_opened: 'La revisión se abrió en el Desktop conectado.', desktop_unavailable: 'No se pudo abrir Desktop. Puedes copiar el enlace.',
  unauthorized: 'Vuelve a iniciar sesión para revisar.',
};
function Evidence({ label, evidence }) {
  const value = evidence?.value;
  return <View style={{ gap: 3 }}><Eyebrow>{label}</Eyebrow><Body muted>{PROVENANCE[evidence?.provenance] || PROVENANCE.unknown}</Body>
    <Body selectable>{typeof value === 'string' || typeof value === 'number' ? String(value) : 'Sin dato'}</Body></View>;
}

export default function ReviewScreen({ obs, route }) {
  const [attemptId, setAttemptId] = useState(route.attemptId || null);
  const [resolveError, setResolveError] = useState(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const lock = useRef(false);
  const { confirm } = useDialogs();
  const view = usePrivateView(obs, REVIEW_ACTION, { attention_id: route.attentionId, attempt_id: attemptId }, !!attemptId);
  useEffect(() => {
    let active = true;
    if (!attemptId && route.taskId && obs.view.kind === 'online') obs.request('core_attempts', { task_id: route.taskId }).then((result) => {
      if (!active) return;
      const id = result.data?.task?.current_attempt_id;
      if (result.ok && id) setAttemptId(id); else setResolveError('No se pudo determinar el intento de esta tarea.');
    });
    return () => { active = false; };
  }, [attemptId, route.taskId, obs.request, obs.view.kind]);
  const data = view.data;
  const proof = data?.proof;
  const head = proof?.revision?.head_commit?.value;
  useEffect(() => setReviewed(false), [head, attemptId, view.fresh]);
  const ready = view.online && view.fresh && reviewed && !busy && reviewReady(data, attemptId, route.attentionId);
  const decide = async (verdict) => {
    if (!ready || lock.current) return;
    lock.current = true; setBusy(true);
    const generation = view.current.current.generation;
    try {
      const ok = await confirm({ title: verdict === 'accepted' ? '¿Aceptar esta revisión?' : '¿Rechazar esta revisión?',
        message: `Tarea ${data.task_id}\nIntento ${attemptId}\nRevisión ${head}`, confirmLabel: verdict === 'accepted' ? 'Aceptar revisión' : 'Rechazar revisión', danger: verdict === 'rejected' });
      if (!ok || !view.current.current.online || !view.current.current.fresh || generation !== view.current.current.generation) return;
      const result = await obs.request(REVIEW_ACTION, { attention_id: route.attentionId, attempt_id: attemptId,
        decision: { review_id: data.review_id, head_commit: head, verdict, confirm: true } });
      setStatus(reviewOutcome(result, attemptId, head, verdict));
      setReviewed(false); view.invalidate(); obs.retry(); view.refresh();
    } finally { setBusy(false); lock.current = false; }
  };
  const openDesktop = async () => {
    if (!view.online || busy || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const result = await obs.request(REVIEW_ACTION, { attention_id: route.attentionId, attempt_id: attemptId, open_desktop: true });
      setStatus(result.ok && result.data?.result?.outcome === 'desktop_opened' ? 'desktop_opened' : result.code || 'desktop_unavailable');
    } finally { lock.current = false; setBusy(false); }
  };
  const code = status || view.error || data?.blocked_reason;
  return <View style={{ gap: 14 }}>
    <Title>Revisión del trabajo</Title>
    <Mono selectable>{`Tarea ${data?.task_id || route.taskId || '…'} · Intento ${attemptId || '…'}`}</Mono>
    {resolveError && <Notice>{resolveError}</Notice>}
    {!view.supported && <Notice>Actualiza Lixbon en el escritorio para revisar desde Mobile.</Notice>}
    {!view.online && <Notice>Sin conexión. No se puede decidir sobre esta revisión.</Notice>}
    {view.loading && <Body muted>Consultando la revisión actual…</Body>}
    {code && <Notice>{messages[code] || 'El Core no pudo completar la operación. Consulta su estado.'}</Notice>}
    {proof && <>
      <Body>{`Policy de revisión · ${data.policy}`}</Body>
      <Eyebrow>Objetivo · {PROVENANCE[proof.objective?.provenance] || PROVENANCE.unknown}</Eyebrow>
      <Body selectable>{proof.objective?.value?.title || 'Sin título'}</Body>
      <Body selectable>{proof.objective?.value?.objective || 'Sin objetivo registrado'}</Body>
      <Evidence label="Revisión" evidence={proof.revision?.head_commit} />
      <Evidence label="Archivos" evidence={proof.changes?.files} />
      <Evidence label="Resumen" evidence={proof.summary} />
      <Evidence label="Pruebas" evidence={proof.tests} />
      <Body muted>{`Proof Pack ${proof.completeness?.state === 'complete' ? 'completo' : 'parcial'} · Lagunas: ${(proof.completeness?.gaps || []).join(', ') || 'ninguna declarada'}`}</Body>
      <Eyebrow>Artefactos · {PROVENANCE[proof.artifacts?.provenance] || PROVENANCE.unknown}</Eyebrow>
      {proof.artifacts?.items?.map((artifact) => <Body key={artifact.id}>{`${artifact.kind} · ${artifact.bytes ?? 'sin tamaño'} bytes · ${artifact.sha256 || 'sin checksum'}`}</Body>)}
      {!proof.artifacts?.items?.length && <Body muted>Sin artefactos registrados. No se verificaron capturas de pantalla.</Body>}
      <Eyebrow>Diff de la revisión mostrada</Eyebrow>
      {data.diff?.readable ? data.diff.files.map((file) => <View key={file.path} style={{ gap: 5 }}>
        <Body selectable>{file.path}</Body><Mono selectable>{file.patch}</Mono>
      </View>) : <Notice>El diff no cabe de forma íntegra en Mobile. Ábrelo en Desktop para decidir.</Notice>}
      {view.fresh && reviewReady(data, attemptId, route.attentionId) && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: reviewed }}
        accessibilityLabel="He revisado esta revisión" disabled={busy} onPress={() => setReviewed((value) => !value)} style={{ minHeight: 48, justifyContent: 'center' }}>
        <Body>{reviewed ? '☑ He revisado esta revisión' : '☐ He revisado esta revisión'}</Body>
      </Pressable>}
      <PillButton label="Aceptar revisión" disabled={!ready} style={{ minHeight: 48 }} onPress={() => decide('accepted')} />
      <PillButton outline label="Rechazar revisión" disabled={!ready} style={{ minHeight: 48 }} onPress={() => decide('rejected')} />
      <PillButton outline label="Open on Desktop" disabled={!view.online || busy || !data.project_id} style={{ minHeight: 48 }} onPress={openDesktop} />
      {typeof data.desktop_link === 'string' && data.desktop_link.startsWith('lixbon://project/') && <PillButton outline label="Copiar enlace para Desktop" onPress={() => Clipboard.setStringAsync(data.desktop_link)} />}
    </>}
    {view.online && !busy && <PillButton outline label="Actualizar revisión" style={{ minHeight: 48 }} onPress={() => { setReviewed(false); view.refresh(); }} />}
  </View>;
}
