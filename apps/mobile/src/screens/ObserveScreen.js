// ObserveScreen.js — sección Supervisar con datos reales del Core (F2, solo lectura).
//
// Sustituye al prototipo de datos de ejemplo (LXO-227, SupervisionScreen.js), que se queda en el repo sin
// montar. Aquí: cabecera con el IDE (host) que se supervisa, banner de conexión (LXO-111) y la pantalla de
// la ruta actual: Home (LXO-108), Proyecto, Attention (LXO-109) y Task Detail (LXO-110).
import React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDialogs } from '../components/dialogs';
import { ChatHeader } from '../components/ui';
import ConnectionBanner from '../observe/ConnectionBanner';
import { KIND } from '../observe/connection';
import { hostName, sessionOnline } from '../observe/hosts';
import { Notice } from '../observe/ui';
import AttentionScreen from './observe/AttentionScreen';
import HomeScreen from './observe/HomeScreen';
import ProjectScreen from './observe/ProjectScreen';
import AttemptScreen from './observe/AttemptScreen';
import TaskScreen from './observe/TaskScreen';

// Pantallas de cada ruta: Home (LXO-108), Proyecto, Atención (LXO-109) y Tarea (LXO-110).
const ROUTES = { home: HomeScreen, project: ProjectScreen, attention: AttentionScreen, task: TaskScreen, attempt: AttemptScreen };

const ROUTE_TITLE = {
  attention: 'Atención',
  task: 'Tarea',
  attempt: 'Intento',
  project: 'Proyecto',
};

export default function ObserveScreen({ obs, onMenu, routes = ROUTES }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { sheet } = useDialogs();
  const gutter = width < 360 ? 12 : 16;
  const { route, session } = obs;
  const atHome = route.name === 'home';

  const pickHost = async () => {
    if (obs.candidates.length === 0) return;
    const value = await sheet({
      title: 'IDE que supervisas',
      items: obs.candidates.map((s) => ({
        label: hostName(s),
        description: sessionOnline(s) ? 'Conectado' : 'Desconectado',
        icon: 'monitor',
        value: s.id,
        selected: s.id === session?.id,
      })),
    });
    if (value) obs.select(value);
  };

  const title = atHome ? (session ? hostName(session, obs.meta) : 'Supervisar') : ROUTE_TITLE[route.name] || 'Supervisar';
  const Route = routes[route.name];

  return (
    <View style={{ flex: 1 }}>
      <ChatHeader
        title={title}
        onTitle={atHome && obs.candidates.length > 1 ? pickHost : undefined}
        dot={atHome ? (obs.view.kind === KIND.ONLINE ? 'live' : 'idle') : null}
        leadingIcon={atHome ? 'menu' : 'arrow-left'}
        onLeading={atHome ? onMenu : obs.pop}
      />
      <ScrollView
        key={obs.stack.length}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 4, paddingBottom: insets.bottom + 32, gap: 18 }}
        showsVerticalScrollIndicator={false}
      >
        <ConnectionBanner view={obs.view} onRetry={obs.retry} hostLabel={session ? hostName(session, obs.meta) : null} />
        {Route ? (
          <Route obs={obs} route={route} />
        ) : (
          <Notice tone="muted" icon="warning" title="Pantalla no disponible">
            Vuelve a Supervisar.
          </Notice>
        )}
      </ScrollView>
    </View>
  );
}
