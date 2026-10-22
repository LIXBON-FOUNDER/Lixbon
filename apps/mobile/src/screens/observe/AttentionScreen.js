// AttentionScreen.js — bandeja de Attention de Supervisar (LXO-109, solo lectura).
//
// Lista en el orden del Core con filtros por Project, categoría y severidad, agrupación opcional por Project,
// icono por categoría, severidad, destino y edad. Las Attention de una Task abren su detalle (LXO-110); abrir
// no resuelve ni marca nada. Sin responder, aprobar, posponer ni «no leído» en F2.
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import Icon from '../../components/Icon';
import { useDialogs } from '../../components/dialogs';
import { Eyebrow, PillButton, useColors } from '../../components/ui';
import {
  CATEGORIES,
  EMPTY_FILTERS,
  SEVERITIES,
  ageText,
  attentionA11y,
  attentionTarget,
  categoryOf,
  groupByProject,
  listNotice,
  projectLabel,
  projectNames,
  severityOf,
} from '../../observe/attention';
import { Body, Notice, StateText } from '../../observe/ui';
import { useAttentionList } from '../../observe/useAttentionList';
import { FONTS, RADIUS } from '../../theme';

function FilterChip({ label, value, onPress }) {
  const c = useColors();
  const on = value != null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Filtrar por ${label}${on ? `: ${value}` : ''}`}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: pressed ? c.pressed : on ? c.surface3 : c.surface2,
      })}
    >
      <Text style={{ fontFamily: on ? FONTS.uiMedium : FONTS.ui, fontSize: 13, color: on ? c.ink : c.inkMuted }}>{on ? value : label}</Text>
      <Icon name="chevron-down" size={12} color={c.inkMuted} />
    </Pressable>
  );
}

/** Fila de Attention. `inert`: no navega (por ejemplo, la Attention de la Task que ya se está viendo). */
export function AttentionRow({ item, names, now, onOpen, inert = false }) {
  const c = useColors();
  const cat = categoryOf(item.category);
  const sev = severityOf(item.severity);
  const found = attentionTarget(item);
  const target = inert ? { ...found, navigable: false } : found;
  return (
    <Pressable
      accessibilityRole={target.navigable ? 'button' : 'text'}
      accessibilityLabel={attentionA11y(item, names, now)}
      disabled={!target.navigable}
      onPress={() => target.navigable && onOpen(target.route)}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? c.pressed : c.surface2,
      })}
    >
      <Icon name={cat.icon} size={18} color={sev.tone === 'error' ? c.danger : sev.tone === 'warn' ? c.warn : c.inkMuted} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>{cat.label}</Text>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
          {`${target.label} · ${projectLabel(item.project_id, names)} · ${ageText(item.created_at, now)}`}
        </Text>
      </View>
      <StateText tone={sev.tone}>{sev.label}</StateText>
      {target.navigable ? <Icon name="chevron-right" size={16} color={c.inkFaint} /> : null}
    </Pressable>
  );
}

export default function AttentionScreen({ obs, route }) {
  const c = useColors();
  const { sheet } = useDialogs();
  const { list, setFilters, more, capability, reachable } = useAttentionList(obs, { active: true });
  const [grouped, setGrouped] = useState(false);
  const snapshot = obs.core?.snapshot;
  const names = projectNames(snapshot);
  const now = obs.now;
  const f = list.filters;

  // Filtro inicial que llega por la ruta (por ejemplo desde un Project de Home).
  React.useEffect(() => {
    if (route?.projectId) setFilters({ ...EMPTY_FILTERS, project_id: route.projectId });
  }, [route?.projectId, setFilters]);

  const pick = async (title, key, options) => {
    const value = await sheet({
      title,
      items: [{ label: 'Todos', value: '__all', selected: f[key] == null }, ...options.map((o) => ({ ...o, selected: f[key] === o.value }))],
    });
    if (value) setFilters({ [key]: value === '__all' ? null : value });
  };

  const notice = listNotice(list, { capability, online: reachable, snapshotTotal: snapshot?.attention?.total });
  const anyFilter = f.project_id || f.category || f.severity;
  const open = (r) => obs.push(r);

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <FilterChip
          label="Proyecto"
          value={f.project_id ? projectLabel(f.project_id, names) : null}
          onPress={() => pick('Proyecto', 'project_id', (snapshot?.projects?.items || []).map((p) => ({ label: p.name, value: p.id, icon: 'layers' })))}
        />
        <FilterChip
          label="Categoría"
          value={f.category ? categoryOf(f.category).label : null}
          onPress={() => pick('Categoría', 'category', CATEGORIES.map((k) => ({ label: categoryOf(k).label, value: k, icon: categoryOf(k).icon })))}
        />
        <FilterChip
          label="Severidad"
          value={f.severity ? severityOf(f.severity).label : null}
          onPress={() => pick('Severidad', 'severity', SEVERITIES.map((k) => ({ label: severityOf(k).label, value: k })))}
        />
        <FilterChip label="Agrupar" value={grouped ? 'Por proyecto' : null} onPress={() => setGrouped((g) => !g)} />
      </View>

      {notice ? <Notice tone={notice.tone} icon="clock">{notice.text}</Notice> : null}

      {list.items.length === 0 ? (
        list.loading || (!snapshot && !list.error) ? (
          <Body muted>Cargando la bandeja…</Body>
        ) : (
          <View style={{ alignItems: 'center', paddingVertical: 32, gap: 8 }}>
            <Icon name="check" size={22} color={c.good} />
            <Body muted style={{ textAlign: 'center' }}>{anyFilter ? 'Nada pide atención con estos filtros.' : 'Nada pide atención ahora mismo.'}</Body>
          </View>
        )
      ) : grouped ? (
        groupByProject(list.items, names).map((g) => (
          <View key={g.projectId || 'none'} style={{ gap: 8 }}>
            <Eyebrow style={{ paddingHorizontal: 4 }}>{`${g.name} · ${g.items.length}`}</Eyebrow>
            {g.items.map((item) => (
              <AttentionRow key={item.id} item={item} names={names} now={now} onOpen={open} />
            ))}
          </View>
        ))
      ) : (
        <View style={{ gap: 8 }}>
          {list.items.map((item) => (
            <AttentionRow key={item.id} item={item} names={names} now={now} onOpen={open} />
          ))}
        </View>
      )}

      {list.hasMore ? <PillButton outline label={list.loading ? 'Cargando…' : 'Cargar más'} onPress={more} disabled={list.loading} /> : null}
    </View>
  );
}
