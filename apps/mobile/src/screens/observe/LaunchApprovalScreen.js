import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { useDialogs } from '../../components/dialogs';
import { PillButton } from '../../components/ui';
import { projectLabel, projectNames } from '../../observe/attention';
import { KIND } from '../../observe/connection';
import { hostName } from '../../observe/hosts';
import { Body, Mono, Notice, Title } from '../../observe/ui';

const ACTION = 'mobile_launch_approval';
const policy = { allow: 'Permitida', confirm: 'Requiere confirmación', elevated: 'Confirmación fuera de banda', deny: 'Denegada' };
const worktree = { new: 'Nuevo worktree aislado', attached: 'Worktree enlazado', resume: 'Continuación de sesión' };
const messages = {
  approved: 'El Core confirmó la aprobación.',
  rejected: 'El Core confirmó el rechazo.',
  expired: 'El plazo de la aprobación venció.',
  resolved: 'La aprobación ya se resolvió.',
  stale: 'La aprobación dejó de estar activa.',
  approval_expired: 'El plazo de la aprobación venció.',
  already_resolved: 'La aprobación ya se resolvió.',
  stale_approval: 'La aprobación cambió. Consulta su estado.',
  policy_denied: 'La policy del Core bloquea esta decisión desde Mobile.',
  policy_out_of_band_required: 'Esta aprobación requiere confirmación fuera de banda.',
  sandbox_requires_desktop: 'Comprueba el sandbox y resuelve esta aprobación desde Desktop.',
  launch_scope_unsupported: 'Esta configuración de lanzamiento requiere Desktop.',
  unsupported_approval: 'Esta solicitud requiere Desktop.',
  unauthorized: 'Vuelve a iniciar sesión en la app para decidir.',
  unconfirmed: 'No llegó confirmación del Core. Consulta el estado antes de repetir la decisión.',
};

function approvalStatus(data) {
  if (data?.status !== 'pending') return data?.status;
  if (data.blocked_reason) return data.blocked_reason;
  if (data.policy === 'elevated') return 'policy_out_of_band_required';
  if (data.policy === 'deny') return 'policy_denied';
  return null;
}

export default function LaunchApprovalScreen({ obs, route }) {
  const { confirm } = useDialogs();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const online = obs.view.kind === KIND.ONLINE && obs.capabilities?.includes(ACTION);
  const current = useRef({});
  current.current = { online, fresh, session: obs.session?.id };
  const locked = useRef(false);
  const { request, retry } = obs;
  const { attentionId, attemptId } = route;
  const cursor = obs.core?.snapshot?.cursor?.events;

  useEffect(() => {
    let active = true;
    setFresh(false);
    if (online) {
      request(ACTION, { attention_id: attentionId, attempt_id: attemptId }).then((result) => {
        if (!active) return;
        const approval = result.data?.result;
        if (result.ok && approval?.attempt_id === attemptId) {
          setData(approval);
          setFresh(true);
        } else {
          setStatus(result.code || 'unconfirmed');
        }
      });
    }
    return () => { active = false; };
  }, [online, request, attentionId, attemptId, cursor, reload]);

  const project = projectLabel(data?.project_id ?? route.projectId, projectNames(obs.core?.snapshot));
  const host = hostName(obs.session, obs.meta);
  const canDecide = online && fresh && data?.can_decide === true && !busy;
  const decide = async (decision) => {
    if (!canDecide || locked.current) return;
    locked.current = true;
    setBusy(true);
    const session = current.current.session;
    const label = decision === 'approve' ? 'Aprobar' : 'Rechazar';
    try {
      const accepted = await confirm({
        title: `¿${label} el lanzamiento?`,
        message: `${project}\nTarea ${data.task_id}\nIntento ${attemptId}\n${host} · ${data.provider}`,
        confirmLabel: label,
        danger: decision === 'reject',
      });
      if (!accepted || !current.current.online || !current.current.fresh || session !== current.current.session) return;
      const result = await request(ACTION, { attention_id: attentionId, attempt_id: attemptId, decision, confirm: true });
      const reply = result.data?.result;
      const expected = decision === 'approve' ? 'approved' : 'rejected';
      setStatus(result.ok && reply?.attempt_id === attemptId && reply.outcome === expected ? expected : result.code || 'unconfirmed');
      setFresh(false);
      retry();
      setReload((value) => value + 1);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const outcome = status || approvalStatus(data);
  return (
    <View style={{ gap: 12 }}>
      <Title>Aprobación de lanzamiento</Title>
      <Body selectable>{project}</Body>
      <Mono selectable>{`Intento ${attemptId}`}</Mono>
      <Body>{`Host · ${host}`}</Body>
      {data && (
        <View style={{ gap: 6 }}>
          <Mono selectable>{`Tarea ${data.task_id}`}</Mono>
          <Body>{`Proveedor · ${data.provider}`}</Body>
          <Body>{`Perfil · ${data.profile || 'Sin perfil'}`}</Body>
          <Body>{`Estrategia · ${worktree[data.worktree_strategy] || 'No disponible'}`}</Body>
          <Body>{`Policy de lanzamiento · ${policy[data.policy] || 'No disponible'}`}</Body>
          {data.status === 'pending' && <Body muted>La decisión está pendiente.</Body>}
        </View>
      )}
      {!data && online && !status && <Body muted>Consultando la aprobación…</Body>}
      {!online && <Notice icon="clock">Conéctate al IDE para tomar una decisión.</Notice>}
      {busy && <Notice tone="info">Esperando confirmación del Core…</Notice>}
      {outcome && <Notice tone={['approved', 'rejected'].includes(outcome) ? 'info' : 'warn'}>{messages[outcome] || 'No se pudo completar la decisión.'}</Notice>}
      {data?.can_decide === true && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <PillButton label="Aprobar" disabled={!canDecide} style={{ minHeight: 48 }} onPress={() => decide('approve')} />
          <PillButton outline label="Rechazar" disabled={!canDecide} style={{ minHeight: 48 }} onPress={() => decide('reject')} />
        </View>
      )}
      {online && status === 'unconfirmed' && !busy && <PillButton outline label="Consultar estado" style={{ minHeight: 48 }} onPress={() => setReload((value) => value + 1)} />}
    </View>
  );
}
