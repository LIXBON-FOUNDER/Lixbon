// TaskScreen.js — Task Detail de Supervisar (LXO-110, solo lectura).
//
// Identidad (Project + Task), estado real con sus señales (pregunta, revisión, integración), proveedor y modelo
// conocidos, ubicación resumida (rama, worktree o checkout compartido, host y origen), Activity reciente
// paginable y la Attention de esta Task. Sin editor, terminal, respuestas ni Attempts (F3). «Abrir en Desktop»
// es un marcador deshabilitado hasta F6.
import React from 'react';
import { Text, View } from 'react-native';

import Icon from '../../components/Icon';
import { Eyebrow, PillButton, useColors } from '../../components/ui';
import { ageText, projectNames } from '../../observe/attention';
import { activityLine, taskNotice } from '../../observe/task';
import { Body, Dot, Mono, Notice, StateText, Title, toneColor } from '../../observe/ui';
import { useTask } from '../../observe/useTask';
import { FONTS, RADIUS } from '../../theme';
import { AttentionRow } from './AttentionScreen';

function Field({ label, children, mono = false, secondary = false }) {
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
const VISUAL_TONE = { success: 'ok', warning: 'warn', error: 'error', info: 'muted' };

export default function TaskScreen({ obs, route }) {
  const c = useColors();
  const t = useTask(obs, { taskId: route.taskId, projectId: route.projectId });
  const m = t.model;
  const names = projectNames(obs.core?.snapshot);
  const notice = taskNotice(m, { online: t.online, error: t.error });

  return (
    <View style={{ gap: 18 }}>
      {notice ? <Notice tone={notice.tone} icon={m.missing ? 'warning' : 'clock'}>{notice.text}</Notice> : null}

      {m.source !== 'none' && (
        <>
          <View style={{ gap: 8 }}>
            <Eyebrow>{m.projectName || (m.projectId ? `Proyecto ${m.projectId.slice(0, 8)}` : 'Sin proyecto')}</Eyebrow>
            <Title>{m.title}</Title>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <StateText tone={m.statusMeta.tone}>{m.statusMeta.label}</StateText>
              {m.phase ? <Body muted>{`${m.phase}${m.phaseAt ? ` · ${ageText(m.phaseAt, obs.now)}` : ''}`}</Body> : null}
            </View>
            {m.flags.map((f) => (
              <StateText key={f.text} tone={f.tone}>{f.text}</StateText>
            ))}
          </View>

          <View style={{ gap: 4, padding: 12, borderRadius: RADIUS, backgroundColor: c.surface2 }}>
            <Field label="Agente">{m.provider || unknown}</Field>
            <Field label="Modelo">{m.model || (m.source === 'detail' ? 'por defecto' : unknown)}</Field>
            <Field label="Rama" mono>{m.branch || (m.source === 'detail' ? 'sin rama propia' : unknown)}</Field>
            <Field label="Checkout">{m.sharedCheckout === null ? unknown : m.sharedCheckout ? 'Compartido con su padre' : 'Worktree propio'}</Field>
            <Field label="Host">{m.host || 'no lo registra el modelo actual'}</Field>
            <Field label="Origen">{m.origin === 'external' ? 'Coordinador externo' : m.origin === 'lixbon' ? 'Lanzada por Lixbon' : unknown}</Field>
            <Field label="Árbol">{m.isRoot ? `Raíz${m.children ? ` · ${m.children} hija${m.children === 1 ? '' : 's'}` : ''}` : 'Hija de otra tarea'}</Field>
            {m.updatedAt ? <Field label="Actualizada">{ageText(m.updatedAt, obs.now)}</Field> : null}
            {/* Invariante 2: la ruta va como ubicación secundaria, nunca como identidad. */}
            {m.location ? <Field label="Ubicación" mono secondary>{m.location}</Field> : null}
            <Field label="Id" mono secondary>{m.id}</Field>
          </View>

          <PillButton
            outline
            icon="monitor"
            label="Abrir en Desktop"
            disabled
            onPress={() => {}}
          />
          <Body muted style={{ marginTop: -10, fontSize: 12.5 }}>Abrir en el escritorio llegará más adelante (F6).</Body>
        </>
      )}

      <View style={{ gap: 8 }}>
        <Eyebrow>{`Atención de esta tarea${t.related.length ? ` · ${t.related.length}` : ''}`}</Eyebrow>
        {t.related.length === 0 ? (
          <Body muted>Nada pide atención en esta tarea.</Body>
        ) : (
          t.related.map((a) => <AttentionRow key={a.id} item={a} names={names} now={obs.now} onOpen={() => {}} inert />)
        )}
        {t.relatedPartial && t.related.length > 0 ? <Body muted style={{ fontSize: 12.5 }}>Solo las más urgentes, de la última sincronización.</Body> : null}
      </View>

      <View style={{ gap: 8 }}>
        <Eyebrow>Actividad</Eyebrow>
        {!t.capability ? (
          <Notice tone="warn" icon="warning">Tu Lixbon de escritorio no envía la actividad de las tareas: actualízalo.</Notice>
        ) : t.activity.items.length === 0 ? (
          <Body muted>{t.activity.loading || !t.activity.loaded ? 'Cargando la actividad…' : 'Sin actividad registrada.'}</Body>
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
        {t.activity.hasMore ? (
          <PillButton outline label={t.activity.loading ? 'Cargando…' : 'Cargar anteriores'} onPress={t.more} disabled={t.activity.loading} />
        ) : null}
      </View>
      {m.source === 'none' && !m.missing && !t.online ? <Icon name="cloud-off" size={20} color={c.inkFaint} /> : null}
    </View>
  );
}
