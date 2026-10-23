// ProjectScreen.js — un Project en Supervisar (LXO-108): su estado y contadores separados, sus Tasks activas y
// el acceso a su Attention. Sale de la snapshot; las Tasks abren su detalle (LXO-110).
import React from 'react';
import { Text, View } from 'react-native';

import { Eyebrow, useColors } from '../../components/ui';
import { projectModel } from '../../observe/home';
import { Body, Notice, StateText, Title } from '../../observe/ui';
import { FONTS } from '../../theme';
import { ActiveTaskRow, RowButton } from './HomeScreen';

export default function ProjectScreen({ obs, route }) {
  const c = useColors();
  const m = projectModel(obs.core?.snapshot, route.projectId);
  if (!m) return <Body muted>Cargando…</Body>;
  if (!m.project) {
    return <Notice tone="muted" icon="warning">Este proyecto no está en el resumen del IDE: puede estar archivado o haber quedado fuera.</Notice>;
  }
  const p = m.project;
  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 8 }}>
        <Title>{p.name}</Title>
        <StateText tone={p.status.tone}>{p.status.label}</StateText>
        <Body muted>{p.counts}</Body>
      </View>
      {p.attention ? (
        <RowButton label={`Ver la atención de ${p.name}: ${p.attention}`} onPress={() => obs.push(m.attentionRoute)}>
          <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{`Ver su atención · ${p.attention}`}</Text>
        </RowButton>
      ) : null}
      <View style={{ gap: 8 }}>
        <Eyebrow>{`Trabajo activo · ${p.active}`}</Eyebrow>
        {m.tasks.length === 0 ? (
          <Body muted>{p.active ? 'Sus tareas activas no caben en el resumen: ábrelo en Desktop.' : 'No hay tareas en marcha.'}</Body>
        ) : (
          m.tasks.map((t) => <ActiveTaskRow key={t.id} task={t} now={obs.now} onOpen={(r) => obs.push(r)} showProject={false} />)
        )}
        {m.partial && m.tasks.length < p.active ? <Body muted style={{ fontSize: 12.5 }}>Puede tener más tareas activas fuera del resumen.</Body> : null}
      </View>
    </View>
  );
}
