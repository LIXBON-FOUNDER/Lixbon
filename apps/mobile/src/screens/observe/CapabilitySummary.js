import React from 'react';
import { View } from 'react-native';

import { Eyebrow, PillButton } from '../../components/ui';
import { ageText } from '../../observe/attention';
import { capabilitySummary } from '../../observe/capabilities';
import { Body, Notice, StateText } from '../../observe/ui';
import { useCoreSummary } from '../../observe/useCoreSummary';

export default function CapabilitySummary({ obs, attemptId }) {
  const summary = useCoreSummary(obs, 'core_attempt_capabilities', { attempt_id: attemptId });
  const data = summary.data;
  const stale = summary.stale || (Number.isFinite(data?.checked_at_ms) && obs.now - data.checked_at_ms >= 60000);
  const environment = { ready: 'Preparado', blocked: 'Bloqueado', unknown: 'Sin información' }[data?.environment] || 'Sin información';
  return (
    <View style={{ gap: 10 }}>
      <Eyebrow>Capacidades del proveedor</Eyebrow>
      {!summary.supported ? <Notice>Actualiza Lixbon en el escritorio para consultar las capacidades.</Notice> : null}
      {summary.loading && !data ? <Body muted>Consultando las capacidades…</Body> : null}
      {data && (
        <>
          <Body>{`${data.provider} · Entorno ${environment.toLowerCase()}`}</Body>
          <Body muted>{`Canal · ${data.transport || 'Sin información'}${data.fallback ? ' (respaldo)' : ''}`}</Body>
          {stale && <Notice icon="clock">{`Desactualizado · ${summary.at ? ageText(data.checked_at_ms ?? summary.at, obs.now) : 'última conexión'}`}</Notice>}
          {data.refreshing && <Body muted>El Core está comprobando las capacidades.</Body>}
          {capabilitySummary(data).map((row) => (
            <View key={row.key} accessible accessibilityLabel={`${row.label}. ${row.stateLabel}. ${row.detail || ''}`} style={{ gap: 4 }}>
              <Body>{row.label}</Body>
              <StateText tone={row.tone}>{row.stateLabel}</StateText>
              {row.detail && <Body muted>{row.detail}</Body>}
            </View>
          ))}
        </>
      )}
      {summary.error && <Notice>No se pudieron actualizar las capacidades.</Notice>}
      {summary.supported && <PillButton outline label="Actualizar capacidades" disabled={!summary.online || summary.loading} style={{ minHeight: 48 }} onPress={summary.refresh} />}
    </View>
  );
}
