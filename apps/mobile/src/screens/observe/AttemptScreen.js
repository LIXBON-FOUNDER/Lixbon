// AttemptScreen.js — un intento (Attempt) de Supervisar (LXO-126, solo lectura).
//
// Se llega desde la lista de intentos de su tarea o desde una Attention que apunta a ese intento exacto. Enseña
// lo que es de la ejecución: estado, proveedor y modelo, fechas, host y origen, resultado y su Attention. Sin
// reintentar, lanzar ni tocar la sesión del proveedor.
import React from 'react';
import { Text, View } from 'react-native';

import { Eyebrow, PillButton, useColors } from '../../components/ui';
import { ageText, projectNames } from '../../observe/attention';
import { attemptResult, attemptStatusOf, originText } from '../../observe/attempts';
import { providerName } from '../../observe/task';
import { Body, Mono, Notice, StateText, Title } from '../../observe/ui';
import { useAttempt } from '../../observe/useAttempts';
import { FONTS, RADIUS } from '../../theme';
import { AttentionRow } from './AttentionScreen';

export function Field({ label, children, mono = false, secondary = false }) {
  const c = useColors();
  return (
    <View accessible accessibilityLabel={`${label}: ${typeof children === 'string' ? children : ''}`} style={{ flexDirection: 'row', gap: 12, minHeight: 28, alignItems: 'baseline' }}>
      <Text style={{ width: 96, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{label}</Text>
      {mono ? (
        <Mono selectable numberOfLines={secondary ? 2 : 1} style={[{ flex: 1 }, secondary && { color: c.inkMuted, fontSize: 11.5 }]}>
          {children}
        </Mono>
      ) : (
        <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14, color: secondary ? c.inkMuted : c.inkBody }}>{children}</Text>
      )}
    </View>
  );
}

const unknown = 'desconocido';
const when = (ms, now) => (Number.isFinite(ms) ? ageText(ms, now) : '—');

export default function AttemptScreen({ obs, route }) {
  const c = useColors();
  const t = useAttempt(obs, route.attemptId);
  const a = t.attempt;
  const names = projectNames(obs.core?.snapshot);

  let notice = null;
  if (!t.capability) notice = { tone: 'warn', text: 'Tu Lixbon de escritorio no envía los intentos de las tareas: actualízalo.' };
  else if (t.missing) notice = { tone: 'muted', text: 'Este intento ya no está en el Core.' };
  else if (!a) notice = { tone: 'muted', text: t.online ? 'Cargando el intento…' : 'Sin datos de este intento hasta que vuelva la conexión.' };
  else if (t.stale) notice = { tone: 'warn', text: `Desactualizado: es el intento de ${t.at ? ageText(t.at, obs.now) : 'la última conexión'}.` };

  const status = a ? attemptStatusOf(a.status) : null;
  const result = a ? attemptResult(a) : null;
  return (
    <View style={{ gap: 18 }}>
      {notice ? <Notice tone={notice.tone} icon="clock">{notice.text}</Notice> : null}
      {a ? (
        <>
          <View style={{ gap: 8 }}>
            <Eyebrow>{route.taskTitle ? `Tarea · ${route.taskTitle}` : `Tarea ${a.task_id || unknown}`}</Eyebrow>
            <Title>{`Intento ${a.n ?? '?'}`}</Title>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <StateText tone={status.tone}>{status.label}</StateText>
              {result ? <StateText tone={result.tone}>{result.text}</StateText> : null}
            </View>
          </View>

          <View style={{ gap: 4, padding: 12, borderRadius: RADIUS, backgroundColor: c.surface2 }}>
            <Field label="Agente">{providerName(a.provider) || unknown}</Field>
            <Field label="Modelo">{a.model || 'por defecto'}</Field>
            {a.role ? <Field label="Rol">{a.role}</Field> : null}
            <Field label="Host">{a.host || unknown}</Field>
            <Field label="Origen">{originText(a.origin)}</Field>
            <Field label="Pedido">{when(a.created_at, obs.now)}</Field>
            <Field label="Empezó">{a.started_at ? when(a.started_at, obs.now) : 'todavía no'}</Field>
            <Field label="Terminó">{a.ended_at ? when(a.ended_at, obs.now) : 'todavía no'}</Field>
            {a.summary ? <Field label="Resumen">{a.summary}</Field> : null}
            <Field label="Id" mono secondary>{a.id}</Field>
          </View>
        </>
      ) : null}

      <View style={{ gap: 8 }}>
        <Eyebrow>{`Atención de este intento${t.attention.length ? ` · ${t.attention.length}` : ''}`}</Eyebrow>
        {t.attention.length === 0 ? (
          <Body muted>Nada pide atención en este intento.</Body>
        ) : (
          t.attention.map((x) => <AttentionRow key={x.id} item={x} names={names} now={obs.now} onOpen={() => {}} inert />)
        )}
        {t.attentionPartial && t.attention.length > 0 ? <Body muted style={{ fontSize: 12.5 }}>Solo las más urgentes, de la última sincronización.</Body> : null}
      </View>

      {a?.task_id && route.from !== 'task' ? (
        <PillButton outline icon="layers" label="Ver la tarea y sus intentos" onPress={() => obs.push({ name: 'task', taskId: a.task_id, projectId: route.projectId || null })} />
      ) : null}
    </View>
  );
}
