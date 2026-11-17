import React, { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { useDialogs } from '../../components/dialogs';
import { PillButton, useColors } from '../../components/ui';
import { projectLabel, projectNames } from '../../observe/attention';
import { KIND } from '../../observe/connection';
import { QUESTION_ACTION, questionLoad, questionReply } from '../../observe/question';
import { Body, Mono, Notice, Title } from '../../observe/ui';
import { FONTS, RADIUS } from '../../theme';

const messages = {
  already_answered: 'La pregunta ya fue respondida.',
  stale_question: 'La pregunta cambió o dejó de estar pendiente.',
  request_unknown: 'La pregunta cambió o dejó de estar pendiente.',
  attempt_final: 'El intento ya terminó.',
  not_running: 'El intento dejó de estar activo.',
  not_waiting: 'El intento ya no espera esta respuesta.',
  in_progress: 'Otra sesión está respondiendo esta pregunta.',
  offline: 'Sin conexión. El borrador sigue disponible en esta pantalla.',
  unconfirmed: 'No llegó confirmación del Core. Consulta la pregunta antes de volver a enviarla.',
  unauthorized: 'Vuelve a iniciar sesión en la app para responder.',
  unsupported_action: 'Actualiza Lixbon en el escritorio para responder desde Mobile.',
  policy_confirm_required: 'La policy requiere confirmar el destino.',
  policy_denied: 'La policy del Core impide responder desde Mobile.',
  policy_out_of_band_required: 'Esta pregunta requiere confirmación fuera de banda.',
  invalid_answer: 'El proveedor necesita una respuesta válida. Si hay varias preguntas, responde una por línea.',
};
const policyText = {
  allow: 'Permitida',
  confirm: 'Requiere confirmación',
  elevated: 'Confirmación fuera de banda',
  deny: 'Denegada',
};

export default function QuestionScreen({ obs, route }) {
  const colors = useColors();
  const { confirm } = useDialogs();
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [reload, setReload] = useState(0);
  const online = obs.view.kind === KIND.ONLINE && obs.capabilities?.includes(QUESTION_ACTION);
  const available = useRef(false);
  available.current = !!online;
  const sending = useRef(false);
  const { request, retry } = obs;
  const { attentionId, attemptId } = route;
  const cursor = obs.core?.snapshot?.cursor?.events;

  useEffect(() => {
    let current = true;
    setFresh(false);
    if (online) {
      request(QUESTION_ACTION, { attention_id: attentionId, attempt_id: attemptId }).then((result) => {
        if (!current) return;
        const loaded = questionLoad(result, attemptId);
        if (loaded.data) {
          setData(loaded.data);
          setFresh(true);
        } else {
          setStatus((previous) => previous === 'answered' ? previous : loaded.code);
        }
      });
    }
    return () => { current = false; };
  }, [online, attentionId, attemptId, request, cursor, reload]);

  const projectId = data?.project_id ?? route.projectId;
  const project = projectLabel(projectId, projectNames(obs.core?.snapshot));
  const send = async (question, key) => {
    const answer = drafts[key]?.trim();
    if (!answer || sending.current || !fresh || !available.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const accepted = await confirm({
        title: '¿Enviar respuesta?',
        message: `${project}\nTarea ${data.task_id}\nIntento ${attemptId}\n\n${question.subject}`,
        confirmLabel: 'Enviar respuesta',
      });
      if (!accepted) return;
      if (!available.current) {
        setStatus('offline');
        return;
      }
      setStatus(null);
      const result = await request(QUESTION_ACTION, {
        attention_id: attentionId, attempt_id: attemptId,
        reply: { request_id: question.request_id, asked_at: question.asked_at, answer, confirm: true },
      });
      const outcome = questionReply(result, attemptId, question.request_id);
      setStatus(outcome);
      if (outcome === 'answered') {
        setDrafts((previous) => ({ ...previous, [key]: '' }));
        setData((previous) => ({ ...previous, questions: previous.questions.filter((q) => q.request_id !== question.request_id || q.asked_at !== question.asked_at) }));
      }
      setFresh(false);
      retry();
      setReload((previous) => previous + 1);
    } finally {
      setBusy(false);
      sending.current = false;
    }
  };

  const canSend = online && fresh && !busy && ['allow', 'confirm'].includes(data?.policy);
  const feedback = status === 'answered' ? 'El Core confirmó la respuesta.' : messages[status] || (status && 'El Core no pudo completar la operación.');
  return (
    <View style={{ gap: 12 }}>
      <Title>Pregunta del proveedor</Title>
      <Body selectable>{projectId ? `${project} (${projectId})` : project}</Body>
      {data && <Mono selectable>{`Tarea ${data.task_id}`}</Mono>}
      <Mono selectable>{`Intento ${attemptId}`}</Mono>
      {data && <Body muted>{`Policy de respuesta · ${policyText[data.policy] || 'No disponible'}`}</Body>}
      {!online && <Notice icon="clock">{messages.offline}</Notice>}
      {busy && <Notice tone="info">Esperando confirmación de la respuesta…</Notice>}
      {feedback && <Notice tone={status === 'answered' ? 'info' : 'warn'}>{feedback}</Notice>}
      {!data && online && !status && <Body muted>Consultando la pregunta en el Core…</Body>}
      {data?.questions.map((question) => {
        const key = `${question.asked_at}:${question.request_id}`;
        return (
          <View key={key} style={{ gap: 8 }}>
            <Body selectable>{question.subject}</Body>
            <TextInput
              accessibilityLabel={`Respuesta a ${question.subject}`}
              editable={!busy}
              multiline
              maxLength={4000}
              placeholder="Escribe tu respuesta"
              placeholderTextColor={colors.inkMuted}
              value={drafts[key] || ''}
              onChangeText={(text) => setDrafts((previous) => ({ ...previous, [key]: text }))}
              style={{ minHeight: 88, padding: 12, textAlignVertical: 'top', color: colors.ink,
                backgroundColor: colors.surface2, fontFamily: FONTS.ui, fontSize: 16, borderRadius: RADIUS }}
            />
            <PillButton label="Revisar y enviar" style={{ minHeight: 48 }} disabled={!canSend || !drafts[key]?.trim()} onPress={() => send(question, key)} />
          </View>
        );
      })}
      {status && status !== 'answered' && online && !busy && (
        <PillButton outline label="Consultar estado" style={{ minHeight: 48 }} onPress={() => setReload((previous) => previous + 1)} />
      )}
    </View>
  );
}
