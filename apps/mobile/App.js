// App.js — raíz de la app móvil con el armazón del IDE: barra de título con
// selector de sección (Chat · Remoto), el panel activo sobre el fondo con luz
// ambiente, la paleta de comandos, el drawer con el historial y las
// pantallas apiladas (Uso, Cuenta, Personalizar) que entran por la derecha.
import * as Clipboard from 'expo-clipboard';
import { useFonts } from 'expo-font';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, BackHandler, Pressable, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import Palette from './src/components/Palette';
import Sidebar from './src/components/Sidebar';
import TitleBar from './src/components/TitleBar';
import { DialogProvider, useDialogs } from './src/components/dialogs';
import { AmbientGlow, EASE, LixLogo, LogoMark, ThemeProvider, useColors, useIsDark, useReducedMotion } from './src/components/ui';
import AccountScreen from './src/screens/AccountScreen';
import AppearanceScreen from './src/screens/AppearanceScreen';
import AuthScreen from './src/screens/AuthScreen';
import ChatScreen from './src/screens/ChatScreen';
import RemoteScreen from './src/screens/RemoteScreen';
import UsageScreen from './src/screens/UsageScreen';
import { shareConversation } from './src/share';
import { AppState, useApi, useAuth, useChat, usePrefs } from './src/state';
import { ACCENTS, FONTS, RADIUS_BOX } from './src/theme';

export default function App() {
  const [fontsLoaded] = useFonts({
    [FONTS.brand]: require('./assets/fonts/BrunoAceSC-Regular.ttf'),
    [FONTS.ui]: require('./assets/fonts/HankenGrotesk-Regular.ttf'),
    [FONTS.uiMedium]: require('./assets/fonts/HankenGrotesk-Medium.ttf'),
    [FONTS.uiSemiBold]: require('./assets/fonts/HankenGrotesk-SemiBold.ttf'),
    [FONTS.uiBold]: require('./assets/fonts/HankenGrotesk-Bold.ttf'),
    [FONTS.mono]: require('./assets/fonts/JetBrainsMono-Regular.ttf'),
    [FONTS.monoMedium]: require('./assets/fonts/JetBrainsMono-Medium.ttf'),
  });

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#070707' }} />;
  }

  return (
    <SafeAreaProvider>
      <AppState>
        <ThemeProvider>
          <DialogProvider>
            <Root />
          </DialogProvider>
        </ThemeProvider>
      </AppState>
    </SafeAreaProvider>
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

// Pantalla de carga del IDE: isotipo y wordmark latiendo sobre el fondo.
function Splash() {
  const c = useColors();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      <AmbientGlow />
      <Animated.View style={{ opacity: pulse, alignItems: 'center', gap: 14 }}>
        <LogoMark size={44} />
        <LixLogo size={20} />
      </Animated.View>
      {reduced && <ActivityIndicator color={c.accent} />}
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
      { id: 'new', title: 'Nueva conversación', category: 'chat', icon: 'plus', run: () => { setSection('chat'); chat.newChat(); } },
      { id: 'model', title: 'Cambiar de modelo', category: 'chat', icon: 'layers', run: pickModel },
      { id: 'web', title: chat.webSearch ? 'Desactivar búsqueda web' : 'Activar búsqueda web', category: 'chat', icon: 'globe', run: () => chat.setWebSearch(!chat.webSearch) },
      last && { id: 'copy', title: 'Copiar la última respuesta', category: 'chat', icon: 'copy', run: async () => { await Clipboard.setStringAsync(last.content); toast('Copiado'); } },
      last && !chat.streaming && { id: 'regen', title: 'Regenerar la última respuesta', category: 'chat', icon: 'refresh', run: () => { setSection('chat'); chat.regenerate(); } },
      chat.messages.length > 0 && { id: 'share', title: 'Compartir conversación (Markdown)', category: 'chat', icon: 'share', run: () => shareConversation(chat.title, chat.messages) },
      { id: 'go.chat', title: 'Ir al chat', category: 'ir a', icon: 'chat', run: () => setSection('chat') },
      { id: 'go.remote', title: 'Ir a Remoto', category: 'ir a', icon: 'activity', keywords: 'ide cli sesiones', run: openRemote },
      { id: 'go.usage', title: 'Uso y límites', category: 'ir a', icon: 'chart', run: () => pushScreen('usage') },
      { id: 'go.account', title: 'Cuenta', category: 'ir a', icon: 'user', run: () => pushScreen('account') },
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
      { id: 'statusbar', title: ui.statusBar ? 'Ocultar la barra de estado' : 'Mostrar la barra de estado', category: 'vista', icon: 'activity', run: () => prefs.setUi({ statusBar: !ui.statusBar }) },
      { id: 'ambient', title: ui.ambient ? 'Apagar la luz ambiente' : 'Encender la luz ambiente', category: 'vista', icon: 'sun', run: () => prefs.setUi({ ambient: !ui.ambient }) },
      { id: 'motion', title: ui.motion ? 'Desactivar animaciones' : 'Activar animaciones', category: 'vista', icon: 'waves', run: () => prefs.setUi({ motion: !ui.motion }) },
      {
        id: 'logout', title: 'Cerrar sesión', category: 'cuenta', icon: 'logout',
        run: async () => {
          const ok = await confirm({ title: 'Cerrar sesión', message: '¿Salir de tu cuenta en este dispositivo?', confirmLabel: 'Cerrar sesión', danger: true });
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
  const auth = useAuth();
  const { sheet } = useDialogs();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.84, 330);

  const [section, setSection] = useState('chat'); // chat | remote
  const [remoteToken, setRemoteToken] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingAsk, setPendingAsk] = useState(null);

  // ── Drawer lateral ─────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef(new Animated.Value(0)).current;

  const animateDrawer = useCallback(
    (to) => {
      Animated.timing(drawer, { toValue: to, duration: reduced ? 0 : 280, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
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
  const [stack, setStack] = useState(null); // null | 'usage' | 'account' | 'appearance'
  const slide = useRef(new Animated.Value(0)).current;

  const pushScreen = useCallback(
    (name) => {
      if (name === 'remote') {
        closeDrawer();
        setSection('remote');
        return;
      }
      setStack(name);
      closeDrawer();
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: reduced ? 0 : 300, easing: EASE, useNativeDriver: true }).start();
    },
    [slide, reduced, closeDrawer],
  );

  const popScreen = useCallback(() => {
    Animated.timing(slide, { toValue: 0, duration: reduced ? 0 : 240, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setStack(null);
    });
  }, [slide, reduced]);

  const openRemote = useCallback(() => setSection('remote'), []);

  const pickModel = useCallback(async () => {
    const value = await sheet({
      title: 'Modelo',
      emptyLabel: 'No hay modelos disponibles.',
      items: chat.models.map((m) => ({ label: m, value: m, selected: m === chat.model, mono: true })),
    });
    if (value) chat.setModel(value);
  }, [sheet, chat]);

  const commands = useCommands({ setSection, pushScreen, pickModel, openRemote });

  // "Preguntar" desde la paleta abre una conversación nueva; el envío espera a
  // que el chat quede vacío para no caer en la conversación anterior.
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

  // Atrás de Android: paleta, drawer, pantalla apilada y Remoto, en ese orden.
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
      if (stack) {
        popScreen();
        return true;
      }
      if (section !== 'chat') {
        setSection('chat');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [paletteOpen, drawerOpen, stack, section, closeDrawer, popScreen]);

  const user = auth.user || {};
  const userName = [user.first_name, user.last_name].filter((x) => typeof x === 'string' && x).join(' ') || user.email || '?';

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <AmbientGlow />
      <TitleBar
        section={section}
        onSection={setSection}
        onMenu={openDrawer}
        onSearch={() => setPaletteOpen(true)}
        onAccount={() => pushScreen('account')}
        userName={userName}
      />

      <View
        style={{
          flex: 1,
          marginHorizontal: 6,
          borderTopLeftRadius: RADIUS_BOX,
          borderTopRightRadius: RADIUS_BOX,
          backgroundColor: c.surface1,
          overflow: 'hidden',
        }}
      >
        <View style={{ flex: 1, display: section === 'chat' ? 'flex' : 'none' }}>
          <ChatScreen />
        </View>
        {section === 'remote' && (
          <RemoteScreen
            key={remoteToken || 'list'}
            embedded
            initialToken={remoteToken}
            onBack={() => {
              setRemoteToken(null);
              setSection('chat');
            }}
          />
        )}
      </View>

      {stack != null && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: c.bg,
            transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) }],
          }}
        >
          {stack === 'usage' ? (
            <UsageScreen onBack={popScreen} />
          ) : stack === 'appearance' ? (
            <AppearanceScreen onBack={popScreen} />
          ) : (
            <AccountScreen onBack={popScreen} onNavigate={pushScreen} />
          )}
        </Animated.View>
      )}

      {drawerOpen && (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
          <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: drawer }}>
            <Pressable onPress={closeDrawer} style={{ flex: 1, backgroundColor: c.scrim }} />
          </Animated.View>
          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: drawerWidth,
              transform: [{ translateX: drawer.interpolate({ inputRange: [0, 1], outputRange: [-drawerWidth, 0] }) }],
            }}
          >
            <Sidebar open={drawerOpen} onClose={closeDrawer} onNavigate={pushScreen} />
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
