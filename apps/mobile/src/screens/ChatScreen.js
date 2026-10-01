// ChatScreen.js — el chat dentro del panel del armazón: cabecera del panel con
// título y opciones, hilo con markdown y acciones por mensaje (copiar,
// compartir, regenerar), bienvenida con sugerencias y el compositor del IDE
// con la barra de estado debajo.
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, Text, TextInput, View } from 'react-native';
import WaveText from '../components/WaveText';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { composeMessage, splitMessage } from '../attachments';
import { AttachmentTray, useAttachments } from '../components/Attachments';
import Icon from '../components/Icon';
import StatusStrip from '../components/StatusStrip';
import { useDialogs } from '../components/dialogs';
import { markdownStyles } from '../components/markdown';
import { FadeUp, KeyboardAware, LogoMark, useColors, useKeyboardOpen, useScale, useUi } from '../components/ui';
import { togglePin, usePins } from '../pins';
import { shareConversation } from '../share';
import { useApi, useAuth, useChat } from '../state';
import { FONTS, RADIUS, RADIUS_BOX } from '../theme';

// Rellenan el compositor en vez de enviar: el usuario completa la idea.
const STARTERS = [
  { icon: 'target', label: 'Investigar un tema a fondo', prompt: 'Investiga a fondo ' },
  { icon: 'doc', label: 'Analizar un documento', prompt: 'Analiza este documento y resume lo importante.', attach: true },
  { icon: 'waves', label: 'Comparar datos y fuentes', prompt: 'Compara estos datos y contrasta las fuentes:\n\n' },
  { icon: 'terminal', label: 'Revisar un fragmento de código', prompt: 'Revisa este código y dime qué mejorarías:\n\n' },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}

export default function ChatScreen({ inputRef: externalInputRef }) {
  const c = useColors();
  const chat = useChat();
  const auth = useAuth();
  const api = useApi();
  const { sheet, prompt, confirm, toast } = useDialogs();
  const [input, setInput] = useState(chat.draftRef.current);
  const pins = usePins(auth.user?.id);
  const ownInputRef = React.useRef(null);
  const inputRef = externalInputRef || ownInputRef;
  const attachments = useAttachments();

  React.useEffect(() => {
    if (chat.models.length === 0) chat.loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saved = !!chat.conversationId && chat.messages.length > 0;
  const pinned = saved && pins.includes(chat.conversationId);
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.content);

  const copy = async (text) => {
    await Clipboard.setStringAsync(text);
    toast('Copiado');
  };

  const pickModel = async () => {
    const value = await sheet({
      title: 'Modelo',
      subtitle: chat.model ? `ahora: ${chat.model}` : 'elige con cuál conversar',
      emptyLabel: 'No hay modelos disponibles.',
      items: chat.models.map((m) => ({ label: m, icon: 'layers', value: m, selected: m === chat.model, mono: true })),
    });
    if (value) chat.setModel(value);
  };

  const openOptions = async () => {
    const action = await sheet({
      title: chat.title || 'Nueva conversación',
      subtitle: [chat.model, chat.webSearch ? 'web on' : null].filter(Boolean).join(' · '),
      items: [
        { group: 'Chat', label: 'Nueva conversación', description: 'Empieza de cero con el mismo modelo', icon: 'plus', value: 'new' },
        { group: 'Chat', label: 'Cambiar de modelo', description: chat.model || 'Sin modelo elegido', icon: 'layers', value: 'model' },
        {
          group: 'Chat',
          label: chat.webSearch ? 'Desactivar búsqueda web' : 'Activar búsqueda web',
          description: chat.webSearch ? 'Responde solo con lo que sabe el modelo' : 'Busca en internet antes de responder',
          icon: 'globe',
          value: 'web',
        },
        ...(lastAssistant ? [{ group: 'Compartir', label: 'Copiar la última respuesta', description: 'Al portapapeles, en Markdown', icon: 'copy', value: 'copy' }] : []),
        ...(chat.messages.length > 0 ? [{ group: 'Compartir', label: 'Compartir como Markdown', description: 'Toda la conversación', icon: 'share', value: 'share' }] : []),
        ...(saved
          ? [
              { group: 'Conversación', label: pinned ? 'Quitar de fijadas' : 'Fijar arriba', description: pinned ? 'Vuelve a su sitio por fecha' : 'Siempre visible en la barra lateral', icon: 'pin', value: 'pin' },
              { group: 'Conversación', label: 'Renombrar', description: 'Cambia el título', icon: 'pencil', value: 'rename' },
              { group: 'Conversación', label: 'Eliminar', description: 'No se puede deshacer', icon: 'trash', danger: true, value: 'delete' },
            ]
          : []),
      ],
    });
    if (action === 'new') chat.newChat();
    if (action === 'model') await pickModel();
    if (action === 'web') chat.setWebSearch(!chat.webSearch);
    if (action === 'copy') copy(lastAssistant.content);
    if (action === 'share') shareConversation(chat.title, chat.messages);
    if (action === 'pin') togglePin(auth.user?.id, chat.conversationId);
    if (action === 'rename') {
      const value = await prompt({
        title: 'Renombrar conversación',
        placeholder: 'Nuevo título',
        initialValue: chat.title || '',
        confirmLabel: 'Guardar',
      });
      const trimmed = (value || '').trim();
      if (!trimmed) return;
      try {
        await api.patch(`/api/conversations/${chat.conversationId}`, { title: trimmed });
        chat.setTitle(trimmed);
      } catch {
        toast('No se pudo renombrar la conversación');
      }
    }
    if (action === 'delete') {
      const ok = await confirm({
        title: 'Eliminar conversación',
        message: `"${chat.title || 'Sin título'}" se eliminará definitivamente.`,
        confirmLabel: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.delete(`/api/conversations/${chat.conversationId}`);
        chat.newChat();
      } catch {
        toast('No se pudo eliminar la conversación');
      }
    }
  };

  const onChangeInput = (v) => {
    setInput(v);
    chat.draftRef.current = v;
  };

  const fill = (text) => {
    onChangeInput(text);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const send = () => {
    const text = input.trim();
    if ((!text && attachments.ready.length === 0) || attachments.reading || chat.streaming) return;
    setInput('');
    chat.draftRef.current = '';
    chat.send(composeMessage(text, attachments.ready));
    attachments.clear();
  };

  const onUserLongPress = async (text) => {
    const action = await sheet({
      title: 'Tu mensaje',
      subtitle: splitMessage(text).text.slice(0, 60),
      items: [
        { label: 'Copiar', description: 'Al portapapeles', icon: 'copy', value: 'copy' },
        { label: 'Editar y volver a enviar', description: 'Lo pone en la caja para corregirlo', icon: 'pencil', value: 'edit' },
      ],
    });
    if (action === 'copy') copy(text);
    if (action === 'edit') fill(splitMessage(text).text);
  };

  const empty = chat.messages.length === 0 && !chat.loadingMessages;
  const firstName = typeof auth.user?.first_name === 'string' ? auth.user.first_name : null;
  const subtitle = chat.streaming ? 'respondiendo…' : chat.model || (chat.models.length === 0 ? 'sin modelos' : '');

  return (
    <KeyboardAware>
      <Pressable
        onPress={openOptions}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 50,
          paddingLeft: 16,
          paddingRight: 8,
          backgroundColor: pressed ? c.pressed : 'transparent',
        })}
      >
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: chat.streaming ? c.accent : c.inkFaint }} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.ink }}>
            {chat.title || 'Nueva conversación'}
          </Text>
          {!!subtitle && (
            <Text numberOfLines={1} style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel }}>
              {subtitle}
            </Text>
          )}
        </View>
        {pinned && (
          <Text style={{ fontFamily: FONTS.mono, fontSize: 10, color: c.accentDeep, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: c.accentSoft }}>
            fijada
          </Text>
        )}
        <Icon name="dots" size={18} color={c.inkSoft} />
      </Pressable>

      <View style={{ flex: 1 }}>
        {chat.loadingMessages ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={c.inkSoft} />
          </View>
        ) : empty ? (
          <Hero
            firstName={firstName}
            onPick={(starter) => {
              fill(starter.prompt);
              if (starter.attach) attachments.pick();
            }}
          />
        ) : (
          <MessageList onCopy={copy} onUserLongPress={onUserLongPress} />
        )}
      </View>

      <Composer
        input={input}
        inputRef={inputRef}
        onChangeInput={onChangeInput}
        onSend={send}
        onPickModel={pickModel}
        attachments={attachments}
      />
    </KeyboardAware>
  );
}

function Hero({ firstName, onPick }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20, paddingBottom: 12 }}>
      <FadeUp style={{ alignItems: 'center', gap: 10 }}>
        <View style={{ padding: 14, borderRadius: RADIUS_BOX, backgroundColor: c.accentSoft, marginBottom: 6 }}>
          <LogoMark size={34} />
        </View>
        <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.accentDeep }}>
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </Text>
        <Text style={{ textAlign: 'center', fontFamily: FONTS.uiSemiBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4, color: c.ink }}>
          ¿Qué investigaremos hoy?
        </Text>
      </FadeUp>

      <View style={{ gap: 6, marginTop: 28 }}>
        {STARTERS.map((s, i) => (
          <FadeUp key={s.icon} delay={80 + i * 50}>
            <Pressable
              onPress={() => onPick(s)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                height: 46,
                paddingHorizontal: 12,
                borderRadius: RADIUS,
                backgroundColor: pressed ? c.surface4 : c.surface2,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              })}
            >
              <Icon name={s.icon} size={16} color={c.accentDeep} />
              <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14, color: c.ink70 }}>{s.label}</Text>
              <Icon name="chevron-right" size={15} color={c.inkFaint} />
            </Pressable>
          </FadeUp>
        ))}
      </View>
    </View>
  );
}

function ActionButton({ icon, label, onPress }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 28,
        paddingHorizontal: 8,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.pressed : 'transparent',
      })}
    >
      <Icon name={icon} size={13} color={c.inkLabel} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkLabel }}>{label}</Text>
    </Pressable>
  );
}

function MessageList({ onCopy, onUserLongPress }) {
  const c = useColors();
  const chat = useChat();
  const { t, s } = useScale();
  const items = [...chat.messages].reverse();

  return (
    <FlatList
      inverted
      data={items}
      keyExtractor={(_, i) => String(chat.messages.length - i)}
      contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => {
        const isLast = index === 0;
        if (item.role === 'user') {
          const { files, text } = splitMessage(item.content);
          return (
            <FadeUp style={{ alignItems: 'flex-end', marginVertical: s(9) }}>
              <Pressable
                onLongPress={() => onUserLongPress(item.content)}
                delayLongPress={300}
                style={({ pressed }) => ({
                  maxWidth: '84%',
                  backgroundColor: pressed ? c.surface4 : c.surface3,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: RADIUS,
                })}
              >
                {files.length > 0 && (
                  <View style={{ gap: 4, marginBottom: text ? 8 : 0 }}>
                    {files.map((f, i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Icon name={f.kind === 'image' ? 'image' : 'file'} size={13} color={c.accentDeep} />
                        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.mono, fontSize: t(11.5), color: c.ink70 }}>
                          {f.name}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
                {!!text && (
                  <Text selectable style={{ fontFamily: FONTS.ui, fontSize: t(14.5), lineHeight: t(21), color: c.ink }}>
                    {text}
                  </Text>
                )}
              </Pressable>
            </FadeUp>
          );
        }
        const words = item.content ? item.content.trim().split(/\s+/).length : 0;
        return (
          <View style={{ marginVertical: s(9) }}>
            {Array.isArray(item.sources) && item.sources.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {item.sources.slice(0, 4).map((src, i) => {
                  const title = String(src?.title || src?.url || '');
                  const url = typeof src?.url === 'string' ? src.url : null;
                  return (
                    <Pressable
                      key={i}
                      onPress={url ? () => Linking.openURL(url) : undefined}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 8,
                        height: 26,
                        borderRadius: RADIUS,
                        backgroundColor: pressed ? c.surface4 : c.surface3,
                      })}
                    >
                      <Icon name="globe" size={12} color={c.inkLabel} />
                      <Text numberOfLines={1} style={{ maxWidth: 150, fontFamily: FONTS.ui, fontSize: 12, color: c.ink70 }}>
                        {title}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {item.content ? (
              <Markdown
                style={markdownStyles(c, t)}
                onLinkPress={(url) => {
                  Linking.openURL(url);
                  return false;
                }}
              >
                {item.content}
              </Markdown>
            ) : isLast && chat.streaming ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: c.accent }} />
                <WaveText
                  text={chat.webSearch ? 'Buscando en internet…' : 'Pensando…'}
                  color={c.ink70}
                  accent={c.accent}
                  style={{ fontFamily: FONTS.ui, fontSize: 13 }}
                />
              </View>
            ) : null}
            {!!item.content && !(isLast && chat.streaming) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, marginLeft: -8 }}>
                <ActionButton icon="copy" label="Copiar" onPress={() => onCopy(item.content)} />
                {isLast && <ActionButton icon="refresh" label="Regenerar" onPress={chat.regenerate} />}
                <Text style={{ marginLeft: 6, fontFamily: FONTS.mono, fontSize: 10, color: c.inkFaint }}>{words} palabras</Text>
              </View>
            )}
          </View>
        );
      }}
    />
  );
}

function Composer({
  input,
  inputRef,
  onChangeInput,
  onSend,
  onPickModel,
  attachments,
}) {
  const c = useColors();
  const chat = useChat();
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const [focused, setFocused] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const hasContent = !!input.trim() || attachments.ready.length > 0;
  const canSend = chat.streaming || (hasContent && !attachments.reading);

  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: keyboardOpen ? 8 : Math.max(insets.bottom, 10) }}>
      {!!chat.error && (
        <View style={{ marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS, backgroundColor: c.dangerSoft, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.danger }}>{chat.error}</Text>
          <Pressable onPress={chat.clearError} hitSlop={8} style={{ padding: 2 }}>
            <Icon name="x" size={15} color={c.danger} />
          </Pressable>
        </View>
      )}

      <View
        style={{
          backgroundColor: focused ? c.surface4 : c.surface3,
          borderRadius: RADIUS_BOX,
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 8,
        }}
      >
        <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={onChangeInput}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Escribe un mensaje…"
          placeholderTextColor={c.inkLabel}
          selectionColor={c.accent}
          multiline
          submitBehavior={ui.sendOnEnter ? 'submit' : 'newline'}
          returnKeyType={ui.sendOnEnter ? 'send' : 'default'}
          onSubmitEditing={ui.sendOnEnter ? onSend : undefined}
          style={{
            maxHeight: 140,
            paddingHorizontal: 4,
            paddingTop: 2,
            paddingBottom: 6,
            fontFamily: FONTS.ui,
            fontSize: 15,
            lineHeight: 21,
            color: c.ink,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <Pressable
            onPress={attachments.pick}
            hitSlop={6}
            accessibilityLabel="Adjuntar"
            style={({ pressed }) => ({
              width: 32,
              height: 32,
              borderRadius: RADIUS,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? c.pressed : 'transparent',
            })}
          >
            <Icon name="clip" size={17} color={c.inkSoft} />
          </Pressable>

          <Pressable
            onPress={() => chat.setWebSearch(!chat.webSearch)}
            hitSlop={6}
            accessibilityLabel="Búsqueda web"
            style={({ pressed }) => ({
              width: 32,
              height: 32,
              borderRadius: RADIUS,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: chat.webSearch ? c.accentSoft : pressed ? c.pressed : 'transparent',
            })}
          >
            <Icon name="globe" size={17} color={chat.webSearch ? c.accentDeep : c.inkSoft} />
          </Pressable>

          <Pressable
            onPress={onPickModel}
            style={({ pressed }) => ({
              flexShrink: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              height: 28,
              paddingHorizontal: 9,
              borderRadius: RADIUS,
              backgroundColor: pressed ? c.surface6 : c.surface5,
            })}
          >
            <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.mono, fontSize: 11.5, color: c.ink70 }}>
              {chat.model || 'sin modelos'}
            </Text>
            <Icon name="chevron-down" size={12} color={c.inkLabel} />
          </Pressable>

          <View style={{ flex: 1 }} />

          <Pressable
            onPress={chat.streaming ? chat.stop : onSend}
            disabled={!canSend}
            accessibilityLabel={chat.streaming ? 'Detener' : 'Enviar'}
            style={({ pressed }) => ({
              width: 36,
              height: 36,
              borderRadius: RADIUS,
              backgroundColor: canSend ? c.primary : c.surface5,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: pressed ? 0.92 : 1 }],
            })}
          >
            <Icon name={chat.streaming ? 'stop' : 'arrow-up'} size={17} color={canSend ? c.onPrimary : c.inkLabel} />
          </Pressable>
        </View>
      </View>

      {ui.statusBar && (
        <View style={{ marginTop: 5 }}>
          <StatusStrip onPickModel={onPickModel} />
        </View>
      )}
    </View>
  );
}
