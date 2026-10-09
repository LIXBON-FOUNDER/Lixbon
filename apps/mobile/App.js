// App.js — raíz de la app móvil: la sección activa (Chat o Remoto) a pantalla
// completa con su propia cabecera, el menú lateral (que cambia de sección y
// guarda el historial), la búsqueda global y las pantallas apiladas (Ajustes,
// Uso, Personalizar) que entran desde la derecha.
import * as Clipboard from 'expo-clipboard';
import { useFonts } from 'expo-font';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, BackHandler, Pressable, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import Palette from './src/components/Palette';
import Sidebar from './src/components/Sidebar';
import { DialogProvider, useDialogs } from './src/components/dialogs';
import { AmbientGlow, Breathe, EASE, LixLogo, LogoMark, ThemeProvider, useColors, useIsDark, useReducedMotion } from './src/components/ui';
import AppearanceScreen from './src/screens/AppearanceScreen';
import AuthScreen from './src/screens/AuthScreen';
import ChatScreen from './src/screens/ChatScreen';
import RemoteScreen from './src/screens/RemoteScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import UsageScreen from './src/screens/UsageScreen';
import { shareConversation } from './src/share';
import { useRemoteSessions } from './src/remoteSessions';
import { AppState, useApi, useAuth, useChat, usePrefs } from './src/state';
import { ACCENTS, FONTS, MOTION } from './src/theme';

export default function App() {
  const [fontsLoaded] = useFonts({
    [FONTS.brand]: require('./assets/fonts/Fraunces-LightItalic.ttf'),
    [FONTS.serif]: require('./assets/fonts/SourceSerif4-Regular.ttf'),
    [FONTS.ui]: require('./assets/fonts/Geist-Regular.ttf'),
    [FONTS.uiMedium]: require('./assets/fonts/Geist-Medium.ttf'),
    [FONTS.uiSemiBold]: require('./assets/fonts/Geist-SemiBold.ttf'),
    [FONTS.mono]: require('./assets/fonts/GeistMono-Regular.ttf'),
    [FONTS.monoMedium]: require('./assets/fonts/GeistMono-Medium.ttf'),
  });

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#0E0E0E' }} />;
  }

  return (
    // La app es edge-to-edge (app.config.js): sin esto keyboard-controller
    // descuenta la barra de navegación y la caja quedaba medio tapada.
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
      <SafeAreaProvider>
        <AppState>
          <ThemeProvider>
            <DialogProvider>
              <Root />
            </DialogProvider>
          </ThemeProvider>
        </AppState>
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}

function Root() {
  const c = useColors();
  const dark = useIsDark();
  const auth = useAuth();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {!auth.ready ? <Splash /> : auth.apiKey ? <HomeShell /> : <AuthScreen />}
    </View>
  );
}

// Pantalla de carga: isotipo y wordmark respirando sobre el fondo.
function Splash() {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Breathe from={0.45} to={1} style={{ alignItems: 'center', gap: 14 }}>
        <LogoMark size={44} />
        <LixLogo size={20} />
      </Breathe>
    </View>
  );
}

function useCommands({ setSection, pushScreen, pickModel, openRemote }) {
  const chat = useChat();
  const prefs = usePrefs();
  const auth = useAuth();
  const api = useApi();
  const { toast, confirm } = useDialogs();
  const ui = prefs.ui;
  const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.content);

  return useMemo(() => {
    const list = [
      { id: 'new', title: 'Nueva conversación', category: 'chat', icon: 'compose', run: () => { setSection('chat'); chat.newChat(); } },
      { id: 'model', title: 'Cambiar de modelo', category: 'chat', icon: 'layers', detail: chat.model, run: pickModel },
      { id: 'web', title: chat.webSearch ? 'Desactivar búsqueda web' : 'Activar búsqueda web', category: 'chat', icon: 'globe', run: () => chat.setWebSearch(!chat.webSearch) },
      last && { id: 'copy', title: 'Copiar la última respuesta', category: 'chat', icon: 'copy', run: async () => { await Clipboard.setStringAsync(last.content); toast('Copiado'); } },
      last && !chat.streaming && { id: 'regen', title: 'Regenerar la última respuesta', category: 'chat', icon: 'refresh', run: () => { setSection('chat'); chat.regenerate(); } },
      chat.messages.length > 0 && { id: 'share', title: 'Compartir conversación (Markdown)', category: 'chat', icon: 'share', run: () => shareConversation(chat.title, chat.messages) },
      { id: 'go.chat', title: 'Ir al chat', category: 'ir a', icon: 'chat', run: () => setSection('chat') },
      { id: 'go.remote', title: 'Ir a Remoto', category: 'ir a', icon: 'activity', keywords: 'ide cli sesiones', run: openRemote },
      { id: 'go.usage', title: 'Uso y límites', category: 'ir a', icon: 'chart', run: () => pushScreen('usage') },
      { id: 'go.settings', title: 'Ajustes', category: 'ir a', icon: 'gear', keywords: 'cuenta perfil', run: () => pushScreen('settings') },
      { id: 'go.appearance', title: 'Personalizar la interfaz', category: 'apariencia', icon: 'palette', keywords: 'tema color acento', run: () => pushScreen('appearance') },
      { id: 'go.docs', title: 'Documentación', category: 'ir a', icon: 'book', run: () => Linking.openURL(`${api.base}/docs`) },
      { id: 'theme.dark', title: 'Tema oscuro', category: 'apariencia', icon: 'moon', run: () => prefs.setThemeMode('dark') },
      { id: 'theme.light', title: 'Tema claro', category: 'apariencia', icon: 'sun', run: () => prefs.setThemeMode('light') },
      { id: 'theme.system', title: 'Tema del sistema', category: 'apariencia', icon: 'gear', run: () => prefs.setThemeMode('system') },
      ...ACCENTS.map((a) => ({
        id: `accent.${a.id}`, title: `Acento: ${a.label}`, category: 'apariencia', keywords: 'color', swatch: a.dark[0],
        run: () => prefs.setUi({ accent: a.id }),
      })),
      { id: 'text.sm', title: 'Texto pequeño', category: 'apariencia', icon: 'type', run: () => prefs.setUi({ textSize: 'sm' }) },
      { id: 'text.md', title: 'Texto normal', category: 'apariencia', icon: 'type', run: () => prefs.setUi({ textSize: 'md' }) },
      { id: 'text.lg', title: 'Texto grande', category: 'apariencia', icon: 'type', run: () => prefs.setUi({ textSize: 'lg' }) },
      { id: 'density.compact', title: 'Densidad compacta', category: 'apariencia', icon: 'menu', run: () => prefs.setUi({ density: 'compact' }) },
      { id: 'density.normal', title: 'Densidad normal', category: 'apariencia', icon: 'menu', run: () => prefs.setUi({ density: 'normal' }) },
      { id: 'density.roomy', title: 'Densidad amplia', category: 'apariencia', icon: 'menu', run: () => prefs.setUi({ density: 'roomy' }) },
      { id: 'motion', title: ui.motion ? 'Desactivar animaciones' : 'Activar animaciones', category: 'vista', icon: 'waves', run: () => prefs.setUi({ motion: !ui.motion }) },
      {
        id: 'logout', title: 'Cerrar sesión', category: 'cuenta', icon: 'logout',
        run: async () => {
          const ok = await confirm({ title: '¿Cerrar sesión?', message: 'Tus conversaciones siguen guardadas en tu cuenta.', confirmLabel: 'Cerrar sesión' });
          if (ok) auth.logout();
        },
      },
    ];
    return list.filter(Boolean);
  }, [chat, prefs, ui, last, auth, api, toast, confirm, setSection, pushScreen, pickModel, openRemote]);
}

function HomeShell() {
  const c = useColors();
  const chat = useChat();
  const { sheet } = useDialogs();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.84, 322);

  const [section, setSection] = useState('chat'); // chat | remote
  const [remoteToken, setRemoteToken] = useState(null);
  const [remoteSession, setRemoteSession] = useState(null);
  const remote = useRemoteSessions();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingAsk, setPendingAsk] = useState(null);

  // ── Menú lateral ───────────────────────────────────────────────────────
  // Entra deslizándose 40px mientras aparece, como en el diseño: un recorrido
  // corto y lento se siente más calmado que cruzar toda la pantalla.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef(new Animated.Value(0)).current;

  const animateDrawer = useCallback(
    (to) => {
      const duration = reduced ? 0 : to ? MOTION.drawer : 320;
      Animated.timing(drawer, { toValue: to, duration, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
        if (finished && to === 0) setDrawerOpen(false);
      });
    },
    [drawer, reduced],
  );

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    animateDrawer(1);
  }, [animateDrawer]);

  const closeDrawer = useCallback(() => animateDrawer(0), [animateDrawer]);

  // ── Pantallas apiladas ─────────────────────────────────────────────────
  const [stack, setStack] = useState([]); // ['settings', 'usage'…]
  const slide = useRef(new Animated.Value(0)).current;
  const top = stack[stack.length - 1] || null;

  const pushScreen = useCallback(
    (name) => {
      if (name === 'remote') {
        closeDrawer();
        setSection('remote');
        return;
      }
      closeDrawer();
      setStack((cur) => [...cur, name]);
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: reduced ? 0 : MOTION.fade, easing: EASE, useNativeDriver: true }).start();
    },
    [slide, reduced, closeDrawer],
  );

  const popScreen = useCallback(() => {
    if (stack.length > 1) {
      setStack((cur) => cur.slice(0, -1));
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: reduced ? 0 : MOTION.fade, easing: EASE, useNativeDriver: true }).start();
      return;
    }
    Animated.timing(slide, { toValue: 0, duration: reduced ? 0 : 320, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setStack([]);
    });
  }, [slide, reduced, stack.length]);

  const openRemote = useCallback(() => setSection('remote'), []);

  const pickModel = useCallback(async () => {
    const value = await sheet({
      title: 'Modelo',
      emptyLabel: 'No hay modelos disponibles.',
      items: chat.models.map((m) => ({ label: m, value: m, selected: m === chat.model })),
    });
    if (value) chat.setModel(value);
  }, [sheet, chat]);

  const commands = useCommands({ setSection, pushScreen, pickModel, openRemote });

  // "Preguntar" desde la búsqueda abre una conversación nueva; el envío espera
  // a que el chat quede vacío para no caer en la conversación anterior.
  const ask = useCallback(
    (text) => {
      setSection('chat');
      chat.newChat();
      setPendingAsk(text);
    },
    [chat],
  );
  useEffect(() => {
    if (pendingAsk && !chat.conversationId && chat.messages.length === 0 && chat.model) {
      chat.send(pendingAsk);
      setPendingAsk(null);
    }
  }, [pendingAsk, chat]);

  // Deep link del QR / control remoto: https://lixbon.com/remote/<token> o
  // lixbon://remote/<token> abre la sesión en la sección Remoto.
  const deepLink = Linking.useURL();
  useEffect(() => {
    if (!deepLink) return;
    const match = deepLink.match(/remote\/([A-Za-z0-9_-]{20,})/);
    if (match) {
      setRemoteToken(match[1]);
      setSection('remote');
    }
  }, [deepLink]);

  useEffect(() => {
    const { onRemoteNotificationTap } = require('./src/push');
    return onRemoteNotificationTap(() => setSection('remote'));
  }, []);

  // Atrás de Android: búsqueda, menú, pantalla apilada y Remoto, en ese orden.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (paletteOpen) {
        setPaletteOpen(false);
        return true;
      }
      if (drawerOpen) {
        closeDrawer();
        return true;
      }
      if (top) {
        popScreen();
        return true;
      }
      if (section === 'remote' && remoteSession) {
        setRemoteSession(null);
        return true;
      }
      if (section !== 'chat') {
        setSection('chat');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [paletteOpen, drawerOpen, top, section, remoteSession, closeDrawer, popScreen]);

  const openSearch = useCallback(() => {
    closeDrawer();
    setPaletteOpen(true);
  }, [closeDrawer]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <AmbientGlow />
      <View style={{ flex: 1, display: section === 'chat' ? 'flex' : 'none' }}>
        <ChatScreen onMenu={openDrawer} onSearch={openSearch} onPickModel={pickModel} />
      </View>
      {section === 'remote' && (
        <RemoteScreen
          key={remoteToken || 'list'}
          initialToken={remoteToken}
          remote={remote}
          session={remoteSession}
          onOpen={setRemoteSession}
          onClose={() => {
            setRemoteToken(null);
            setRemoteSession(null);
          }}
          onMenu={openDrawer}
        />
      )}

      {top != null && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: c.bg,
            opacity: slide,
            transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [48, 0] }) }],
          }}
        >
          {top === 'usage' ? (
            <UsageScreen onBack={popScreen} />
          ) : top === 'appearance' ? (
            <AppearanceScreen onBack={popScreen} />
          ) : (
            <SettingsScreen onBack={popScreen} onNavigate={pushScreen} />
          )}
        </Animated.View>
      )}

      {drawerOpen && (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
          <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: drawer }}>
            <Pressable accessibilityLabel="Cerrar menú" onPress={closeDrawer} style={{ flex: 1, backgroundColor: c.scrim }} />
          </Animated.View>
          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: drawerWidth,
              opacity: drawer,
              transform: [{ translateX: drawer.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }],
            }}
          >
            <Sidebar
              open={drawerOpen}
              onClose={closeDrawer}
              onNavigate={pushScreen}
              section={section}
              onSection={setSection}
              onSearch={openSearch}
              remote={remote}
              activeRemoteId={remoteSession?.id}
              onOpenSession={(sx) => {
                setSection('remote');
                setRemoteSession(sx);
                closeDrawer();
              }}
            />
          </Animated.View>
        </View>
      )}

      <Palette
        visible={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        onOpenConversation={(it) => {
          setSection('chat');
          chat.openConversation(it.id, typeof it.title === 'string' ? it.title : null);
        }}
        onAsk={ask}
      />
    </View>
  );
}
