// AttemptScreen.js — un intento (Attempt) de Supervisar (LXO-126, LXO-127; solo lectura).
//
// Se llega desde la lista de intentos de su tarea o desde una Attention que apunta a ese intento exacto. Todo lo
// que enseña es de ESE intento: estado y ciclo de vida, proveedor y modelo, la sesión del proveedor resumida (su id
// es opaco y no llega), el Worktree (la ruta es ubicación, no identidad), los Artifacts, la revisión (vigente u
// obsoleta, sin ambigüedad), su Attention y su Activity. Sin reanudar, lanzar, detener ni ver el diff.
import React from 'react';
import { Text, View } from 'react-native';

import { Eyebrow, PillButton, useColors } from '../../components/ui';
import { ageText, projectNames } from '../../observe/attention';
import { attemptDetailModel } from '../../observe/attempts';
import { activityLine } from '../../observe/task';
import { Body, Dot, Mono, Notice, StateText, Title, toneColor } from '../../observe/ui';
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

function Box({ children }) {
  const c = useColors();
  return <View style={{ gap: 4, padding: 12, borderRadius: RADIUS, backgroundColor: c.surface2 }}>{children}</View>;
}

const unknown = 'desconocido';
const VISUAL_TONE = { success: 'ok', warning: 'warn', error: 'error', info: 'muted' };
const when = (ms, now) => (Number.isFinite(ms) ? ageText(ms, now) : 'todavía no');

export default function AttemptScreen({ obs, route }) {
  const c = useColors();
  const t = useAttempt(obs, route.attemptId);
  const a = t.attempt;
  const m = attemptDetailModel(a, t.task);
  const names = projectNames(obs.core?.snapshot);
  const taskTitle = m?.taskTitle || route.taskTitle || null;

  let notice = null;
  if (!t.capability) notice = { tone: 'warn', text: 'Tu Lixbon de escritorio no envía los intentos de las tareas: actualízalo.' };
  else if (t.missing) notice = { tone: 'muted', text: 'Este intento ya no está en el Core.' };
  else if (!a) notice = { tone: 'muted', text: t.online ? 'Cargando el intento…' : 'Sin datos de este intento hasta que vuelva la conexión.' };
  else if (t.stale) notice = { tone: 'warn', text: `Desactualizado: es el intento de ${t.at ? ageText(t.at, obs.now) : 'la última conexión'}.` };

  return (
    <View style={{ gap: 18 }}>
      {notice ? <Notice tone={notice.tone} icon="clock">{notice.text}</Notice> : null}
      {m ? (
        <>
          <View style={{ gap: 8 }}>
            <Eyebrow>{taskTitle ? `Tarea · ${taskTitle}` : `Tarea ${m.taskId || unknown}`}</Eyebrow>
            <Title>{`Intento ${m.n ?? '?'}`}</Title>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <StateText tone={m.status.tone}>{m.status.label}</StateText>
              {m.result ? <StateText tone={m.result.tone}>{m.result.text}</StateText> : null}
              {m.current === true ? <Body muted>El actual de su tarea</Body> : m.current === false ? <Body muted>No es el actual de su tarea</Body> : null}
            </View>
            <Body muted>{m.lifecycle}</Body>
          </View>

          <View style={{ gap: 8 }}>
            <Eyebrow>Ejecución</Eyebrow>
            <Box>
              <Field label="Agente">{m.provider}</Field>
              <Field label="Modelo">{m.model || 'por defecto'}</Field>
              {m.effort ? <Field label="Esfuerzo">{m.effort}</Field> : null}
              {m.profile ? <Field label="Perfil">{m.profile}</Field> : null}
              {m.role ? <Field label="Rol">{m.role}</Field> : null}
              <Field label="Host">{m.host || unknown}</Field>
              <Field label="Origen">{m.origin}</Field>
              <Field label="Pedido">{when(a.created_at, obs.now)}</Field>
              <Field label="Empezó">{when(a.started_at, obs.now)}</Field>
              <Field label="Terminó">{when(a.ended_at, obs.now)}</Field>
              {m.summary ? <Field label="Resumen">{m.summary}</Field> : null}
              <Field label="Id" mono secondary>{m.id}</Field>
            </Box>
          </View>

          <View style={{ gap: 8 }}>
            <Eyebrow>Sesión del proveedor</Eyebrow>
            {m.session.present ? (
              <Box>
                <Field label="Estado">{m.session.status}</Field>
                {m.session.resumable ? <Field label="Reanudar">{m.session.resumable}</Field> : null}
                <Field label="Vínculo">{m.session.bound}</Field>
                <Field label="Origen">{m.session.opened}</Field>
              </Box>
            ) : (
              <Body muted>Este intento no tiene una sesión del proveedor registrada.</Body>
            )}
          </View>

          <View style={{ gap: 8 }}>
            <Eyebrow>Worktree</Eyebrow>
            {m.worktree.present ? (
              <Box>
                <Field label="Rama" mono>{m.worktree.branch || 'sin rama'}</Field>
                {m.worktree.base ? <Field label="Base" mono>{m.worktree.base}</Field> : null}
                <View accessible accessibilityLabel={`Estado: ${m.worktree.state.label}`} style={{ flexDirection: 'row', gap: 12, minHeight: 28, alignItems: 'center' }}>
                  <Text style={{ width: 96, fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Estado</Text>
                  <StateText tone={m.worktree.state.tone}>{m.worktree.state.label}</StateText>
                </View>
                <Field label="Procedencia">{m.worktree.provenance}</Field>
                <Field label="Host">{m.worktree.host || unknown}</Field>
                {m.worktree.branchKept ? <Field label="Rama">Se conserva al retirarlo</Field> : null}
                {/* Invariante 3: la ruta es ubicación secundaria, nunca la identidad del intento. */}
                {m.worktree.path ? <Field label="Ubicación" mono secondary>{m.worktree.path}</Field> : null}
              </Box>
            ) : (
              <Body muted>Sin worktree propio registrado: trabajó en un checkout compartido o aún no tiene uno.</Body>
            )}
          </View>

          <View style={{ gap: 8 }}>
            <Eyebrow>{`Artefactos${m.artifacts.length ? ` · ${m.artifacts.length}` : ''}`}</Eyebrow>
            {m.artifacts.length === 0 ? (
              <Body muted>Este intento no ha dejado artefactos.</Body>
            ) : (
              <Box>
                {m.artifacts.map((x, i) => (
                  <Field key={`${x.kind}-${i}`} label={x.label} mono>{x.short}</Field>
                ))}
              </Box>
            )}
          </View>

          <View style={{ gap: 8 }}>
            <Eyebrow>Revisión</Eyebrow>
            <View accessible accessibilityLabel={`${m.review.title}. ${m.review.text}`} style={{ gap: 4 }}>
              <StateText tone={m.review.tone}>{m.review.title}</StateText>
              <Body muted>{m.review.text}</Body>
            </View>
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

      {t.capability ? (
        <View style={{ gap: 8 }}>
          <Eyebrow>Actividad de este intento</Eyebrow>
          {t.activity.items.length === 0 ? (
            <Body muted>{t.activity.loading || (!t.activity.loaded && t.online) ? 'Cargando la actividad…' : t.online ? 'Sin actividad registrada.' : 'Sin la actividad hasta que vuelva la conexión.'}</Body>
          ) : (
            t.activity.items.map((item) => {
              const line = activityLine(item);
              return (
                <View key={line.seq} accessible accessibilityLabel={`${line.text} ${ageText(line.ts, obs.now)}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', minHeight: 32 }}>
                  <View style={{ paddingTop: 8 }}>
                    <Dot color={toneColor(VISUAL_TONE[line.visual], c)} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Body>{line.text}</Body>
                    <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkFaint }}>{ageText(line.ts, obs.now)}</Text>
                  </View>
                </View>
              );
            })
          )}
          {t.activity.error && t.activity.items.length ? <Body muted style={{ fontSize: 12.5 }}>No se pudo actualizar la actividad.</Body> : null}
          {t.activity.hasMore ? <PillButton outline label={t.activity.loading ? 'Cargando…' : 'Cargar anteriores'} onPress={t.more} disabled={t.activity.loading} /> : null}
        </View>
      ) : null}

      {m?.taskId && route.from !== 'task' ? (
        <PillButton outline icon="layers" label="Ver la tarea y sus intentos" onPress={() => obs.push({ name: 'task', taskId: m.taskId, projectId: t.task?.project_id || route.projectId || null })} />
      ) : null}
    </View>
  );
}
