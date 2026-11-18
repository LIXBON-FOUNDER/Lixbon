import React from 'react';
import { View } from 'react-native';

import { Eyebrow, PillButton, useColors } from '../../components/ui';
import { ageText } from '../../observe/attention';
import { Body, Notice, StateText, Title } from '../../observe/ui';
import { usageCard } from '../../observe/usage';
import { useCoreSummary } from '../../observe/useCoreSummary';
import { RADIUS } from '../../theme';

export default function UsageScreen({ obs }) {
  const colors = useColors();
  const summary = useCoreSummary(obs, 'core_usage');
  const data = summary.data;
  return (
    <View style={{ gap: 14 }}>
      <Title>Uso de proveedores</Title>
      {!summary.supported && <Notice>Actualiza Lixbon en el escritorio para consultar el uso de los proveedores.</Notice>}
      {(!data || data.status === 'loading') && summary.supported && <Body muted>{summary.online ? 'Consultando el uso…' : 'Conéctate al IDE para consultar el uso.'}</Body>}
      {summary.stale && data && <Notice icon="clock">{`Datos de la última sincronización · ${ageText(summary.at, obs.now)}`}</Notice>}
      {data?.refreshing && <Body muted>El Core está actualizando los proveedores.</Body>}
      {data?.providers.map((provider) => {
        const card = usageCard(provider, { stale: summary.stale, now: obs.now });
        return (
          <View key={provider.provider} style={{ gap: 8, padding: 14, borderRadius: RADIUS, backgroundColor: colors.surface2 }}>
            <Eyebrow>{card.name}</Eyebrow>
            <StateText tone={card.tone}>{card.status}</StateText>
            {card.account && <Body muted>{`Cuenta · ${card.account}`}</Body>}
            {card.provenance && <Body muted>{`${card.provenance} · ${ageText(card.observedAt, obs.now)}`}</Body>}
            {card.error && <Notice>{card.error}</Notice>}
            {card.limitReached && <Notice>El proveedor informa que se alcanzó el límite.</Notice>}
            {card.throttled && <Body muted>El refresco está limitado. Se conserva el último dato.</Body>}
            {card.metrics.map((metric) => <Body key={metric.label}>{`${metric.label} · ${metric.text}`}</Body>)}
            {card.windows.map((window) => (
              <View key={window.id} accessible style={{ gap: 3 }}>
                <Body>{`${window.label} · ${window.value}${window.minutes ? ` · ${window.minutes}` : ''}`}</Body>
                <Body muted>{Number.isSafeInteger(window.resetsAt) && window.resetsAt * 1000 <= 8640000000000000
                  ? `Reinicio · ${new Date(window.resetsAt * 1000).toLocaleString('es')}`
                  : 'Sin hora de reinicio'}</Body>
              </View>
            ))}
            {card.models.map((model) => (
              <View key={model.name} accessible style={{ gap: 3 }}>
                <Body>{model.name}</Body>
                {model.tokens && <Body muted>{model.tokens}</Body>}
                {model.cost !== null && <Body muted>{`Coste informado · ${model.cost}`}</Body>}
              </View>
            ))}
            {card.truncated && <Body muted>El resumen móvil está recortado. Consulta el detalle en el escritorio.</Body>}
          </View>
        );
      })}
      {data?.status === 'ready' && data.providers.length === 0 && <Body muted>El Core todavía no informa del uso de ningún proveedor.</Body>}
      {data?.truncated && <Notice>Hay más proveedores. Consulta el informe completo en el escritorio.</Notice>}
      {summary.error && <Notice>No se pudo actualizar el uso. Se conserva el último informe disponible.</Notice>}
      {summary.supported && <PillButton outline label="Actualizar uso" disabled={!summary.online || summary.loading} style={{ minHeight: 48 }} onPress={summary.refresh} />}
    </View>
  );
}
