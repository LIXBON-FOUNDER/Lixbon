// ChatScreen.js — conversación con streaming SSE, markdown en respuestas y
// selector de modelo. Espejo del chat de la web (chat.css): hero centrado
// "¿Qué investigaremos hoy?" en vacío, burbuja del usuario invertida
// (radius-box con esquina 15), y compositor caja (.chat-input): texto arriba
// y barra inferior con búsqueda web + modelo a la izquierda y enviar (círculo
// tinta 40px) a la derecha.
import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import { useDialogs } from '../components/dialogs';
import { FadeUp, IconButton, useColors } from '../components/ui';
import { useAuth, useChat } from '../state';
import { FONTS, RADIUS_BOX, RADIUS_PILL } from '../theme';

export default function ChatScreen() {
  const c = useColors();
  const chat = useChat();
  const auth = useAuth();
  const [input, setInput] = useState(chat.draftRef.current);

  React.useEffect(() => {
    if (chat.models.length === 0) chat.loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El draft sobrevive al cambio de pestaña (vive en el contexto).
  const onChangeInput = (v) => {
    setInput(v);
    chat.draftRef.current = v;
  };

  const send = () => {
    const text = input.trim();
    if (!text || chat.streaming) return;
    setInput('');
    chat.draftRef.current = '';
    chat.send(text);
  };

  const empty = chat.messages.length === 0 && !chat.loadingMessages;
  const firstName = typeof auth.user?.first_name === 'string' ? auth.user.first_name : null;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Cabecera: título + nueva conversación (.chat-header) */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 18,
          paddingRight: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: c.borderSoft,
        }}
      >
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink }}
        >
          {chat.title || 'Nueva conversación'}
        </Text>
        <IconButton onPress={chat.newChat}>
          <Icon name="edit" size={18} color={c.ink} />
        </IconButton>
      </View>

      <View style={{ flex: 1 }}>
        {chat.loadingMessages ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={c.inkSoft} />
          </View>
        ) : empty ? (
          <Hero firstName={firstName} />
        ) : (
          <MessageList />
        )}
      </View>

      <Composer
        input={input}
        onChangeInput={onChangeInput}
        onSend={send}
      />
    </SafeAreaView>
  );
}

// Hero del chat vacío (.chat-hero): saludo + título grande centrado.
function Hero({ firstName }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 60 }}>
      <FadeUp style={{ alignItems: 'center', gap: 10 }}>
        {!!firstName && (
          <Text style={{ fontFamily: FONTS.ui, fontSize: 15, color: c.inkSoft }}>
            Hola, {firstName}.
          </Text>
        )}
        <Text
          style={{
            textAlign: 'center',
            fontFamily: FONTS.uiMedium,
            fontSize: 27,
            lineHeight: 34,
            color: c.ink,
          }}
        >
          ¿Qué investigaremos hoy?
        </Text>
      </FadeUp>
    </View>
  );
}

function MessageList() {
  const c = useColors();
  const chat = useChat();
  // Lista invertida: el índice 0 es el último mensaje → auto-scroll natural.
  const items = [...chat.messages].reverse();

  return (
    <FlatList
      inverted
      data={items}
      keyExtractor={(_, i) => String(chat.messages.length - i)}
      contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 14 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => {
        const isLast = index === 0;
        if (item.role === 'user') {
          return (
            <FadeUp style={{ alignItems: 'flex-end', marginVertical: 8 }}>
              <View
                style={{
                  maxWidth: '80%',
                  backgroundColor: c.primary,
                  paddingHorizontal: 19,
                  paddingVertical: 11,
                  borderRadius: RADIUS_BOX,
                  borderBottomRightRadius: 15,
                }}
              >
                <Text style={{ fontFamily: FONTS.ui, fontSize: 15, lineHeight: 22, color: c.onPrimary }}>
                  {item.content}
                </Text>
              </View>
            </FadeUp>
          );
        }
        return (
          <View style={{ marginVertical: 8 }}>
            {Array.isArray(item.sources) && item.sources.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {item.sources.slice(0, 4).map((s, i) => {
                  const title = String(s?.title || s?.url || '');
                  const url = typeof s?.url === 'string' ? s.url : null;
                  return (
                    <Pressable
                      key={i}
                      onPress={url ? () => Linking.openURL(url) : undefined}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingLeft: 10,
                        paddingRight: 8,
                        paddingVertical: 5,
                        borderRadius: RADIUS_PILL,
                        borderWidth: 1,
                        borderColor: c.borderSoft,
                        backgroundColor: pressed ? c.bgSecondary : c.bg,
                      })}
                    >
                      <Icon name="globe" size={12} color={c.inkSoft} />
                      <Text
                        numberOfLines={1}
                        style={{ maxWidth: 150, fontFamily: FONTS.ui, fontSize: 12, color: c.inkSoft }}
                      >
                        {title}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {item.content ? (
              <Markdown
                style={markdownStyles(c)}
                onLinkPress={(url) => {
                  Linking.openURL(url);
                  return false;
                }}
              >
                {item.content}
              </Markdown>
            ) : isLast && chat.streaming ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator size="small" color={c.inkSoft} />
                <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
                  Pensando…
                </Text>
              </View>
            ) : null}
          </View>
        );
      }}
    />
  );
}

// Compositor (.chat-composer / .chat-input): caja crema redondeada con el
// texto arriba y una barra inferior de acciones.
function Composer({ input, onChangeInput, onSend }) {
  const c = useColors();
  const chat = useChat();
  const { sheet } = useDialogs();

  const pickModel = async () => {
    const value = await sheet({
      title: 'Modelo',
      emptyLabel: 'No hay modelos disponibles.',
      items: chat.models.map((m) => ({ label: m, value: m, selected: m === chat.model })),
    });
    if (value) chat.setModel(value);
  };

  const canSend = !!input.trim() || chat.streaming;

  return (
    <View style={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12 }}>
      {!!chat.error && (
        <View
          style={{
            marginBottom: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
            backgroundColor: c.dangerSoft,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.danger }}>
            {chat.error}
          </Text>
          <Pressable onPress={chat.clearError} hitSlop={8} style={{ padding: 2 }}>
            <Icon name="x" size={15} color={c.danger} />
          </Pressable>
        </View>
      )}

      <View
        style={{
          backgroundColor: c.bgInput,
          borderRadius: RADIUS_BOX,
          paddingHorizontal: 15,
          paddingTop: 11,
          paddingBottom: 9,
        }}
      >
        <TextInput
          value={input}
          onChangeText={onChangeInput}
          placeholder="Escribe un mensaje…"
          placeholderTextColor={c.inkSoft}
          multiline
          style={{
            maxHeight: 130,
            paddingHorizontal: 6,
            paddingTop: 2,
            paddingBottom: 6,
            fontFamily: FONTS.ui,
            fontSize: 15,
            lineHeight: 21,
            color: c.ink,
          }}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 4,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
            {/* Búsqueda web: activo = círculo de tinta (is-active de la web) */}
            <Pressable
              onPress={() => chat.setWebSearch(!chat.webSearch)}
              hitSlop={6}
              style={({ pressed }) => ({
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: chat.webSearch ? c.primary : pressed ? c.pressed : 'transparent',
              })}
            >
              <Icon name="globe" size={18} color={chat.webSearch ? c.onPrimary : c.ink} />
            </Pressable>

            {/* Selector de modelo (.chat-input__model: pill con borde suave) */}
            <Pressable
              onPress={pickModel}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                marginLeft: 6,
                paddingLeft: 13,
                paddingRight: 9,
                paddingVertical: 6,
                borderRadius: RADIUS_PILL,
                borderWidth: 1,
                borderColor: c.borderSoft,
                backgroundColor: pressed ? c.pressed : 'transparent',
                maxWidth: 190,
              })}
            >
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.ink }}
              >
                {chat.model || 'Sin modelos'}
              </Text>
              <Icon name="chevron-down" size={13} color={c.inkSoft} />
            </Pressable>
          </View>

          {/* Enviar / detener (.chat-input__send: círculo tinta 40px) */}
          <Pressable
            onPress={chat.streaming ? chat.stop : onSend}
            disabled={!canSend}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: c.primary,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !canSend ? 0.45 : pressed ? 0.85 : 1,
            })}
          >
            <Icon name={chat.streaming ? 'stop' : 'arrow-up'} size={17} color={c.onPrimary} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// Estilos del markdown con los tokens de marca. Un único estilo de código
// (fondo bgSecondary) cubre inline y bloques para que el texto tinta sea
// legible en los dos temas.
function markdownStyles(c) {
  return {
    body: { fontFamily: FONTS.ui, fontSize: 15, lineHeight: 23, color: c.ink },
    heading1: { fontFamily: FONTS.uiSemiBold, fontSize: 20, color: c.ink, marginTop: 8, marginBottom: 4 },
    heading2: { fontFamily: FONTS.uiSemiBold, fontSize: 18, color: c.ink, marginTop: 8, marginBottom: 4 },
    heading3: { fontFamily: FONTS.uiSemiBold, fontSize: 16, color: c.ink, marginTop: 6, marginBottom: 3 },
    strong: { fontFamily: FONTS.uiBold, color: c.ink },
    em: { fontStyle: 'italic', color: c.ink },
    link: { color: c.accentDeep, textDecorationLine: 'underline' },
    bullet_list_icon: { color: c.inkSoft },
    ordered_list_icon: { color: c.inkSoft, fontFamily: FONTS.ui },
    blockquote: {
      backgroundColor: c.bgSecondary,
      borderLeftWidth: 1,
      borderLeftColor: c.borderSoft,
      borderRadius: 6,
      paddingHorizontal: 12,
      marginVertical: 4,
    },
    code_inline: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.ink,
      backgroundColor: c.bgSecondary,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    code_block: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.ink,
      backgroundColor: c.bgSecondary,
      borderColor: c.borderSoft,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginVertical: 6,
    },
    fence: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.ink,
      backgroundColor: c.bgSecondary,
      borderColor: c.borderSoft,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginVertical: 6,
    },
    hr: { backgroundColor: c.borderSoft, height: 1, marginVertical: 10 },
    table: { borderColor: c.borderSoft, borderWidth: 1, borderRadius: 10 },
    th: { fontFamily: FONTS.uiSemiBold, fontSize: 13, color: c.ink, padding: 6 },
    td: { fontFamily: FONTS.ui, fontSize: 13, color: c.ink, padding: 6 },
    tr: { borderColor: c.borderSoft },
  };
}
