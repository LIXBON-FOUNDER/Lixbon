// observe/ConnectionBanner.js — banner de conexión de Supervisar (LXO-111). Siempre arriba: en línea es una
// línea discreta con la hora de la última sincronización; el resto, un aviso con texto accionable y
// «Reintentar» cuando sirve. El texto lo decide connectionView (connection.js), aquí solo se pinta.
import React from 'react';
import { View } from 'react-native';

import { Eyebrow } from '../components/ui';
import { KIND, connectionA11y } from './connection';
import { Mono, Notice, StateText } from './ui';

const ICON = {
  [KIND.CONNECTING]: 'refresh',
  [KIND.RECONNECTING]: 'refresh',
  [KIND.STALE]: 'clock',
  [KIND.OFFLINE]: 'cloud-off',
  [KIND.UNAUTHORIZED]: 'key',
  [KIND.VERSION_MISMATCH]: 'warning',
};

export default function ConnectionBanner({ view, onRetry, hostLabel }) {
  if (!view) return null;
  const a11y = connectionA11y(view);
  if (view.kind === KIND.ONLINE) {
    return (
      <View accessible accessibilityLabel={a11y} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, minHeight: 28 }}>
        <Eyebrow>{hostLabel || 'Supervisar'}</Eyebrow>
        <StateText tone="ok">{view.lastSync ? `Al día · ${view.lastSync}` : 'Al día'}</StateText>
      </View>
    );
  }
  const tone = view.tone === 'error' ? 'error' : view.tone === 'warn' ? 'warn' : 'muted';
  const sync = view.lastSync ? ` Última sincronización: ${view.lastSync}.` : '';
  return (
    <View style={{ gap: 6 }}>
      <Notice
        tone={tone}
        icon={ICON[view.kind]}
        title={view.title}
        action={view.retry ? 'Reintentar' : null}
        onAction={onRetry}
        accessibilityLabel={a11y}
      >
        {`${view.detail || ''}${sync}`.trim() || null}
      </Notice>
      {view.code && (view.kind === KIND.OFFLINE || view.kind === KIND.VERSION_MISMATCH) ? (
        // Diagnóstico mínimo: el código estable, sin mensajes ni rutas.
        <Mono style={{ paddingHorizontal: 4, fontSize: 11.5, opacity: 0.7 }} accessibilityLabel={`Código ${view.code}`}>
          {`código: ${view.code}`}
        </Mono>
      ) : null}
    </View>
  );
}
