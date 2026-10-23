// HomeScreen.js — Home de Supervisar (LXO-108): resumen operativo del IDE elegido. Projects con su estado y
// contadores separados (activas, fallidas, Attention), el trabajo activo global, la Attention por categoría y la
// salud del Core. Solo resume (sale de la snapshot); el ADE completo está en Desktop.
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import Icon from '../../components/Icon';
import { Eyebrow, useColors } from '../../components/ui';
import { ageText } from '../../observe/attention';
import { activeA11y, homeModel, projectA11y } from '../../observe/home';
import { Body, Notice, StateText } from '../../observe/ui';
import { FONTS, RADIUS } from '../../theme';

export function RowButton({ onPress, label, children }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 56, paddingVertical: 10, paddingHorizontal: 12, borderRadius: RADIUS, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: pressed ? c.pressed : c.surface2 })}
    >
      {children}
      <Icon name="chevron-right" size={16} color={c.inkFaint} />
    </Pressable>
  );
}

export function ActiveTaskRow({ task, now, onOpen, showProject = true }) {
  const c = useColors();
  return (
    <RowButton label={activeA11y(task)} onPress={() => onOpen(task.route)}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={2} style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{task.title}</Text>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
          {[showProject ? task.projectName : null, task.child ? 'hija' : null, task.origin, task.updatedAt ? ageText(task.updatedAt, now) : null].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <StateText tone={task.status.tone}>{task.status.label}</StateText>
    </RowButton>
  );
}

export default function HomeScreen({ obs }) {
  const c = useColors();
  const home = homeModel(obs.core?.snapshot);
  const open = (route) => obs.push(route);

  if (!home) {
    // Sin snapshot todavía: el banner de conexión dice por qué (conectando, sin IDE, offline…).
    return obs.session ? <Body muted>Cargando el resumen del IDE…</Body> : null;
  }

  return (
    <View style={{ gap: 22 }}>
      {home.health === 'read_only' ? (
        <Notice tone="warn" icon="warning" title="Lixbon en el escritorio está en solo lectura">
          Puedes ver su estado, pero allí no se puede lanzar ni cambiar nada hasta reiniciarlo.
        </Notice>
      ) : null}

      <View style={{ gap: 8 }}>
        <Eyebrow>{home.attention.total ? `Atención · ${home.attention.total}` : 'Atención'}</Eyebrow>
        {home.attention.total === 0 ? (
          <Body muted>Nada pide atención ahora mismo.</Body>
        ) : (
          <>
            {home.attention.categories.map((cat) => (
              <RowButton key={cat.key} label={`${cat.label}: ${cat.count}`} onPress={() => open(cat.route)}>
                <Icon name={cat.icon} size={18} color={cat.key === 'failed' ? c.danger : c.warn} />
                <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14.5, color: c.inkBody }}>{cat.label}</Text>
                <Text style={{ fontFamily: FONTS.mono, fontSize: 13, color: c.inkMuted }}>{cat.count}</Text>
              </RowButton>
            ))}
            <RowButton label="Ver toda la atención" onPress={() => open(home.attention.route)}>
              <Text style={{ flex: 1, fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>Ver toda la atención</Text>
            </RowButton>
          </>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Eyebrow>{`Trabajo activo · ${home.activeTotal}`}</Eyebrow>
        {home.active.length === 0 ? (
          <Body muted>No hay tareas en marcha.</Body>
        ) : (
          home.active.map((t) => <ActiveTaskRow key={t.id} task={t} now={obs.now} onOpen={open} />)
        )}
        {home.activeHidden ? <Body muted style={{ fontSize: 12.5 }}>{`Y ${home.activeHidden} más: el resumen enseña las 50 más recientes.`}</Body> : null}
      </View>

      <View style={{ gap: 8 }}>
        <Eyebrow>{`Proyectos · ${home.projectsTotal}`}</Eyebrow>
        {home.projects.length === 0 ? (
          <Body muted>Sin proyectos registrados. Se registran desde Lixbon en el escritorio o al lanzar un run en un repositorio.</Body>
        ) : (
          home.projects.map((p) => (
            <RowButton key={p.id} label={projectA11y(p)} onPress={() => open(p.route)}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{p.name}</Text>
                <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{p.counts}</Text>
              </View>
              <StateText tone={p.status.tone}>{p.status.label}</StateText>
            </RowButton>
          ))
        )}
        {home.projectsHidden ? <Body muted style={{ fontSize: 12.5 }}>{`Y ${home.projectsHidden} más: primero los que piden algo.`}</Body> : null}
        {home.unassigned.active || home.unassigned.attention ? (
          <Body muted style={{ fontSize: 12.5 }}>
            {`Sin proyecto: ${home.unassigned.active} activa${home.unassigned.active === 1 ? '' : 's'}${home.unassigned.failed ? ` · ${home.unassigned.failed} fallida${home.unassigned.failed === 1 ? '' : 's'}` : ''}${home.unassigned.attention ? ` · ${home.unassigned.attention} piden atención` : ''}`}
          </Body>
        ) : null}
      </View>

      {home.version ? <Text style={{ fontFamily: FONTS.mono, fontSize: 11.5, color: c.inkFaint, paddingHorizontal: 4 }}>{`Core ${home.version}`}</Text> : null}
    </View>
  );
}
