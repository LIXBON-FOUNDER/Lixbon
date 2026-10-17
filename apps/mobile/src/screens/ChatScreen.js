// ChatScreen.js — el chat a pantalla completa: cabecera (menú, título que abre
// las acciones, nueva conversación), bienvenida con titular en serif y
// sugerencias, hilo con fuentes y código, y el compositor con "+" (adjuntar y
// búsqueda web), modelo y enviar.
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { FlatList, Linking, Pressable, Text, TextInput, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { composeMessage, splitMessage } from '../attachments';
import { AttachmentTray, useAttachments } from '../components/Attachments';
import CameraModal from '../components/Camera';
import Icon from '../components/Icon';
import ShimmerText from '../components/ShimmerText';
import StepSlider from '../components/StepSlider';
import { useDialogs } from '../components/dialogs';
import { markdownRules, markdownStyles } from '../components/markdown';
import {
  ChatHeader,
  FadeUp,
  KeyboardAware,
  Meter,
  ScreenTitle,
  SkeletonLines,
  Toggle,
  useColors,
  useKeyboardOpen,
  useScale,
  useUi,
} from '../components/ui';
import { togglePin, usePins } from '../pins';
import { shareConversation } from '../share';
import { ETIQUETA_RAZONAR } from '../razonamiento';
import { useApi, useAuth, useChat } from '../state';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';

// Rellenan el compositor en vez de enviar: el usuario completa la idea.
const STARTERS = [
  { icon: 'target', label: 'Investigar a fondo', prompt: 'Investiga a fondo ' },
  { icon: 'file', label: 'Analizar un documento', prompt: 'Analiza este documento y resume lo importante.', attach: true },
  { icon: 'waves', label: 'Comparar fuentes', prompt: 'Compara estos datos y contrasta las fuentes:\n\n' },
  { icon: 'terminal', label: 'Revisar código', prompt: 'Revisa este código y dime qué mejorarías:\n\n' },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}

export default function ChatScreen({ onMenu, onSearch, onPickModel, inputRef: externalInputRef }) {
  const chat = useChat();
  const auth = useAuth();
  const api = useApi();
  const { sheet, toast } = useDialogs();
  const [input, setInput] = useState(chat.draftRef.current);
  const pins = usePins(auth.user?.id);
  const ownInputRef = React.useRef(null);
  const inputRef = externalInputRef || ownInputRef;
  const attachments = useAttachments();
  const [cameraOpen, setCameraOpen] = useState(false);

  React.useEffect(() => {
    if (chat.models.length === 0) chat.loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saved = !!chat.conversationId && chat.messages.length > 0;
  const pinned = saved && pins.includes(chat.conversationId);
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.content);

  const copy = async (text) => {
    await Clipboard.setStringAsync(text);
    toast('Copiado', { icon: 'check' });
  };

  const pickModel = async () => {
    if (onPickModel) return onPickModel();
    const value = await sheet({
      title: 'Modelo',
      emptyLabel: 'No hay modelos disponibles.',
      items: chat.models.map((m) => ({ label: m, value: m, selected: m === chat.model })),
    });
    if (value) chat.setModel(value);
  };

  const rename = async (value) => {
    const trimmed = (value || '').trim();
    if (!trimmed || trimmed === chat.title || !chat.conversationId) return;
    try {
      await api.patch(`/api/conversations/${chat.conversationId}`, { title: trimmed });
      chat.setTitle(trimmed);
    } catch {
      toast('No se pudo renombrar la conversación');
    }
  };

  // Deshacer en vez de confirmar: se sale de la conversación al momento y el
  // borrado real se manda cuando el aviso se va.
  const remove = () => {
    const id = chat.conversationId;
    const title = chat.title;
    chat.newChat();
    toast('Conversación eliminada', {
      action: { label: 'Deshacer', onPress: () => chat.openConversation(id, title) },
      onTimeout: () => api.delete(`/api/conversations/${id}`).catch(() => toast('No se pudo eliminar la conversación')),
    });
  };

  const openActions = async () => {
    if (!saved) return;
    const action = await sheet({
      keyboard: true,
      render: (close) => (
        <ConversationActions
          title={chat.title || ''}
          pinned={pinned}
          canCopy={!!lastAssistant}
          onRename={rename}
          onPick={close}
        />
      ),
    });
    if (action === 'pin') togglePin(auth.user?.id, chat.conversationId);
    if (action === 'share') shareConversation(chat.title, chat.messages);
    if (action === 'copy') copy(lastAssistant.content);
    if (action === 'delete') remove();
  };

  const openAttach = async () => {
    const source = await sheet({ render: (close) => <AttachSheet onPick={close} /> });
    if (source === 'camera') setCameraOpen(true);
    else if (source) attachments.pickFrom(source);
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
      items: [
        { label: 'Copiar', icon: 'copy', value: 'copy' },
        { label: 'Editar y volver a enviar', icon: 'pencil', value: 'edit' },
      ],
    });
    if (action === 'copy') copy(text);
    if (action === 'edit') fill(splitMessage(text).text);
  };

  const empty = chat.messages.length === 0 && !chat.loadingMessages;
  const firstName = typeof auth.user?.first_name === 'string' ? auth.user.first_name : null;

  return (
    <KeyboardAware>
      {empty ? (
        <ChatHeader title="Nueva conversación" onLeading={onMenu} trailing="search" trailingLabel="Buscar" onTrailing={onSearch} />
      ) : (
        <ChatHeader
          title={chat.title || 'Nueva conversación'}
          onLeading={onMenu}
          onTitle={saved ? openActions : undefined}
          trailing="compose"
          trailingLabel="Nueva conversación"
          onTrailing={chat.newChat}
        />
      )}

      <View style={{ flex: 1 }}>
        {chat.loadingMessages ? (
          <ThreadSkeleton />
        ) : empty ? (
          <Hero firstName={firstName} />
        ) : (
          <MessageList onCopy={copy} onUserLongPress={onUserLongPress} />
        )}
      </View>

      {empty && (
        <Starters
          onPick={(starter) => {
            fill(starter.prompt);
            if (starter.attach) attachments.pickFrom('doc');
          }}
        />
      )}

      <Composer
        input={input}
        inputRef={inputRef}
        placeholder={empty ? 'Escribe un mensaje…' : 'Responder…'}
        onChangeInput={onChangeInput}
        onSend={send}
        onPickModel={pickModel}
        onAttach={openAttach}
        attachments={attachments}
      />

      <CameraModal
        visible={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDone={(files, text) => {
          setCameraOpen(false);
          attachments.addFiles(files);
          if (text) fill(input ? `${input.trim()}
${text}` : text);
        }}
      />
    </KeyboardAware>
  );
}

// Saludo y titular abajo, cerca del compositor: al alcance del pulgar.
function Hero({ firstName }) {
  const c = useColors();
  return (
    <FadeUp style={{ flex: 1, justifyContent: 'flex-end', gap: 10, paddingHorizontal: 24, paddingBottom: 22 }}>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted }}>
        {greeting()}
        {firstName ? `, ${firstName}` : ''}
      </Text>
      <ScreenTitle style={{ fontSize: 32, lineHeight: 36 }}>¿Qué investigamos hoy?</ScreenTitle>
    </FadeUp>
  );
}

// Las sugerencias, a la vista en una lista agrupada (antes era un carrusel
// que escondía la mitad).
function Starters({ onPick }) {
  const c = useColors();
  return (
    <FadeUp delay={120} style={{ marginHorizontal: 20, marginBottom: 22, borderRadius: RADIUS, backgroundColor: c.sheet, overflow: 'hidden' }}>
      {STARTERS.map((s, i) => (
        <View key={s.label}>
          {i > 0 && <View style={{ height: 1, marginLeft: 44, backgroundColor: c.surface3 }} />}
          <Pressable
            onPress={() => onPick(s)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              height: 52,
              paddingHorizontal: 14,
              backgroundColor: pressed ? c.surface4 : 'transparent',
            })}
          >
            <Icon name={s.icon} size={18} color={c.accent} strokeWidth={1.7} />
            <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 15, color: c.inkBody }}>{s.label}</Text>
            <Icon name="chevron-right" size={14} color={c.inkFaint} />
          </Pressable>
        </View>
      ))}
    </FadeUp>
  );
}

function ThreadSkeleton() {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 12, gap: 26 }}>
      <SkeletonLines widths={['52%']} height={36} style={{ alignItems: 'flex-end' }} />
      <SkeletonLines widths={['90%', '96%', '74%']} height={13} />
      <SkeletonLines widths={['38%']} height={36} style={{ alignItems: 'flex-end' }} />
      <SkeletonLines widths={['84%', '92%', '66%']} height={13} />
    </View>
  );
}

/// Acciones de la conversación: el título se edita en la misma hoja (sin un
/// diálogo aparte) y debajo las acciones, con eliminar separado al final.
function ConversationActions({ title, pinned, canCopy, onRename, onPick }) {
  const c = useColors();
  const [value, setValue] = useState(title);
  const committed = React.useRef(title);
  const commit = () => {
    if (value.trim() === committed.current) return;
    committed.current = value.trim();
    onRename(value);
  };
  const items = [
    { label: pinned ? 'Quitar de fijadas' : 'Fijar arriba', icon: 'pin', value: 'pin' },
    { label: 'Compartir como Markdown', icon: 'share', value: 'share' },
    ...(canCopy ? [{ label: 'Copiar la última respuesta', icon: 'copy', value: 'copy' }] : []),
  ];
  const row = (it, danger = false) => (
    <Pressable
      key={it.value}
      onPress={() => {
        commit();
        onPick(it.value);
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        height: 52,
        paddingHorizontal: 14,
        borderRadius: RADIUS,
        backgroundColor: pressed ? c.pressed : 'transparent',
      })}
    >
      <Icon name={it.icon} size={19} color={danger ? c.danger : c.inkSoft} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 15, color: danger ? c.danger : c.ink }}>{it.label}</Text>
    </Pressable>
  );
  return (
    <View>
      <View style={{ marginTop: 8, marginBottom: 10, paddingHorizontal: 4, gap: 6 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Título</Text>
        <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 12, borderRadius: RADIUS, backgroundColor: c.surface4 }}>
          <TextInput
            value={value}
            onChangeText={setValue}
            onSubmitEditing={commit}
            onBlur={commit}
            returnKeyType="done"
            selectionColor={c.accent}
            accessibilityLabel="Título de la conversación"
            style={{ flex: 1, paddingVertical: 0, fontFamily: FONTS.uiMedium, fontSize: 16, color: c.ink }}
          />
          <Icon name="pencil" size={16} color={c.inkMuted} />
        </View>
      </View>
      {items.map((it) => row(it))}
      <View style={{ height: 1, marginVertical: 6, marginHorizontal: 14, backgroundColor: c.borderSoft }} />
      {row({ label: 'Eliminar conversación', icon: 'trash', value: 'delete' }, true)}
    </View>
  );
}

/// "+" del compositor: tres orígenes grandes y la búsqueda web en la misma
/// hoja, que se activa sin cerrarla.
function AttachSheet({ onPick }) {
  const c = useColors();
  const chat = useChat();
  const tiles = [
    { value: 'camera', icon: 'camera', label: 'Cámara' },
    { value: 'gallery', icon: 'image', label: 'Galería' },
    { value: 'doc', icon: 'file', label: 'Documento' },
  ];
  return (
    <View style={{ paddingHorizontal: 4, gap: 16 }}>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        {tiles.map((tile) => (
          <Pressable
            key={tile.value}
            onPress={() => onPick(tile.value)}
            style={({ pressed }) => ({
              flex: 1,
              height: 96,
              borderRadius: RADIUS,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              backgroundColor: pressed ? c.surface4 : c.surface3,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            })}
          >
            <Icon name={tile.icon} size={24} color={c.inkBody} />
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.ink }}>{tile.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={() => chat.setWebSearch(!chat.webSearch)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 4 }}
      >
        <Icon name="globe" size={22} color={chat.webSearch ? c.accent : c.inkSoft} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}>Búsqueda web</Text>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Busca en internet antes de responder</Text>
        </View>
        <Toggle value={chat.webSearch} onChange={chat.setWebSearch} label="Búsqueda web" />
      </Pressable>
      {chat.nivelesRazonar.length > 0 && (
        <View style={{ gap: 10, paddingHorizontal: 4, paddingBottom: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Icon name="bolt" size={22} color={chat.razonar !== 'auto' && chat.razonar !== 'off' ? c.accent : c.inkSoft} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}>Razonamiento</Text>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>
                {chat.razonar === 'auto' || !chat.nivelesRazonar.includes(chat.razonar)
                  ? 'Razona solo cuando el mensaje lo pide'
                  : 'Más razonamiento, mejor en lo difícil pero tarda más'}
              </Text>
            </View>
          </View>
          <StepSlider
            steps={chat.nivelesRazonar}
            value={chat.nivelesRazonar.includes(chat.razonar) ? chat.razonar : 'auto'}
            onChange={chat.setRazonar}
            labelOf={(n) => ETIQUETA_RAZONAR[n]}
          />
        </View>
      )}
    </View>
  );
}

function hostOf(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

function Sources({ sources }) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, 2);
  const chip = { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: RADIUS_SM };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
      {shown.map((src, i) => {
        const url = typeof src?.url === 'string' ? src.url : null;
        const label = hostOf(url) || String(src?.title || '');
        return (
          <Pressable
            key={i}
            onPress={url ? () => Linking.openURL(url) : undefined}
            style={({ pressed }) => [chip, { backgroundColor: pressed ? c.surface4 : c.surface2 }]}
          >
            {i === 0 && <Icon name="globe" size={13} color={c.inkMuted} />}
            <Text numberOfLines={1} style={{ maxWidth: 160, fontFamily: FONTS.ui, fontSize: 12.5, color: c.ink70 }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
      {!all && sources.length > 2 && (
        <Pressable onPress={() => setAll(true)} style={({ pressed }) => [chip, { backgroundColor: pressed ? c.surface4 : c.surface2 }]}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.ink70 }}>+{sources.length - 2}</Text>
        </Pressable>
      )}
    </View>
  );
}

function MessageAction({ icon, label, onPress }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
    >
      <Icon name={icon} size={17} color={c.inkMuted} />
    </Pressable>
  );
}

function MessageList({ onCopy, onUserLongPress }) {
  const c = useColors();
  const chat = useChat();
  const { toast } = useDialogs();
  const { t, s } = useScale();
  const items = [...chat.messages].reverse();
  const mdStyles = React.useMemo(() => markdownStyles(c, t), [c, t]);
  const mdRules = React.useMemo(() => markdownRules(c, t, () => toast('Código copiado', { icon: 'check' })), [c, t, toast]);

  return (
    <FlatList
      inverted
      data={items}
      keyExtractor={(_, i) => String(chat.messages.length - i)}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => {
        const isLast = index === 0;
        if (item.role === 'user') {
          const { files, text } = splitMessage(item.content);
          return (
            <FadeUp style={{ alignItems: 'flex-end', marginVertical: s(11) }}>
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
                        <Icon name={f.kind === 'image' ? 'image' : 'file'} size={14} color={c.inkSoft} />
                        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: t(13), color: c.ink70 }}>
                          {f.name}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
                {!!text && (
                  <Text selectable style={{ fontFamily: FONTS.ui, fontSize: t(15), lineHeight: t(22.5), color: c.ink }}>
                    {text}
                  </Text>
                )}
              </Pressable>
            </FadeUp>
          );
        }
        const working = isLast && chat.streaming;
        return (
          <FadeUp style={{ marginVertical: s(11) }}>
            {Array.isArray(item.sources) && item.sources.length > 0 && <Sources sources={item.sources} />}
            {item.content ? (
              <Markdown
                style={mdStyles}
                rules={mdRules}
                onLinkPress={(url) => {
                  Linking.openURL(url);
                  return false;
                }}
              >
                {item.content}
              </Markdown>
            ) : working ? (
              chat.webSearch ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon name="globe" size={15} color={c.inkMuted} />
                  <ShimmerText text="Buscando en internet…" style={{ fontFamily: FONTS.ui, fontSize: 15 }} />
                </View>
              ) : (
                <ShimmerText text="Pensando…" style={{ fontFamily: FONTS.uiMedium, fontSize: 15 }} />
              )
            ) : null}
            {!!item.content && !working && (
              <View style={{ flexDirection: 'row', gap: 2, marginLeft: -10, marginTop: -4 }}>
                <MessageAction icon="copy" label="Copiar respuesta" onPress={() => onCopy(item.content)} />
                {isLast && <MessageAction icon="refresh" label="Regenerar" onPress={chat.regenerate} />}
                {isLast && <MessageAction icon="share" label="Compartir" onPress={() => shareConversation(chat.title, chat.messages)} />}
              </View>
            )}
          </FadeUp>
        );
      }}
    />
  );
}

function Composer({ input, inputRef, placeholder, onChangeInput, onSend, onPickModel, onAttach, attachments }) {
  const c = useColors();
  const chat = useChat();
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const hasContent = !!input.trim() || attachments.ready.length > 0;
  const canSend = hasContent && !attachments.reading;

  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: keyboardOpen ? 8 : Math.max(insets.bottom, 14) }}>
      {!!chat.quota && (
        <FadeUp style={{ marginBottom: 8, minHeight: 40, paddingLeft: 14, paddingRight: 6, borderRadius: RADIUS, backgroundColor: chat.quota.state === 'exhausted' ? c.dangerSoft : c.warnSoft, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, paddingVertical: 8, fontFamily: FONTS.ui, fontSize: 13.5, color: chat.quota.state === 'exhausted' ? c.danger : c.warn }}>{chat.quota.message}</Text>
          <Pressable onPress={chat.clearQuota} accessibilityLabel="Cerrar aviso de cupo" style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={15} color={chat.quota.state === 'exhausted' ? c.danger : c.warn} />
          </Pressable>
        </FadeUp>
      )}
      {!!chat.error && (
        <FadeUp style={{ marginBottom: 8, minHeight: 40, paddingLeft: 14, paddingRight: 6, borderRadius: RADIUS, backgroundColor: c.dangerSoft, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, paddingVertical: 8, fontFamily: FONTS.ui, fontSize: 13.5, color: c.danger }}>{chat.error}</Text>
          <Pressable onPress={chat.clearError} accessibilityLabel="Cerrar aviso" style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={15} color={c.danger} />
          </Pressable>
        </FadeUp>
      )}

      <View style={{ backgroundColor: c.surface2, borderRadius: RADIUS, paddingTop: attachments.items.length ? 10 : 14, paddingLeft: attachments.items.length ? 10 : 14, paddingRight: 10, paddingBottom: 10 }}>
        <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={onChangeInput}
          placeholder={placeholder}
          placeholderTextColor={c.inkMuted}
          selectionColor={c.accent}
          accessibilityLabel="Mensaje"
          multiline
          submitBehavior={ui.sendOnEnter ? 'submit' : 'newline'}
          returnKeyType={ui.sendOnEnter ? 'send' : 'default'}
          onSubmitEditing={ui.sendOnEnter ? onSend : undefined}
          style={{
            maxHeight: 150,
            paddingHorizontal: attachments.items.length ? 4 : 0,
            paddingVertical: 0,
            fontFamily: FONTS.ui,
            fontSize: 15,
            lineHeight: 22,
            color: c.ink,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 10, marginLeft: attachments.items.length ? -2 : -6 }}>
          <Pressable
            onPress={onAttach}
            accessibilityLabel="Adjuntar o activar búsqueda web"
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
          >
            <Icon name="plus" size={20} color={c.ink70} />
          </Pressable>

          <Pressable
            onPress={onPickModel}
            accessibilityLabel={`Modelo: ${chat.model || 'sin modelos'}`}
            style={({ pressed }) => ({
              flexShrink: 1,
              height: 40,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              borderRadius: RADIUS_SM,
              backgroundColor: pressed ? c.pressed : 'transparent',
            })}
          >
            <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.ui, fontSize: 13.5, color: c.ink70 }}>
              {chat.model || 'Sin modelos'}
            </Text>
            <Icon name="chevron-down" size={14} color={c.ink70} strokeWidth={1.8} />
          </Pressable>

          {chat.webSearch && (
            <Pressable
              onPress={() => chat.setWebSearch(false)}
              accessibilityLabel="Búsqueda web activada, tocar para quitar"
              style={{ height: 30, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: RADIUS_SM, backgroundColor: `rgba(${c.accentRgb},0.12)` }}
            >
              <Icon name="globe" size={13} color={c.accent} strokeWidth={1.8} />
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.accent }}>Web</Text>
            </Pressable>
          )}

          {chat.razonar !== 'auto' && chat.nivelesRazonar.includes(chat.razonar) && (
            <Pressable
              onPress={onAttach}
              accessibilityLabel={`Razonamiento: ${ETIQUETA_RAZONAR[chat.razonar]}`}
              style={{ height: 30, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: RADIUS_SM, backgroundColor: `rgba(${c.accentRgb},0.12)` }}
            >
              <Icon name="bolt" size={13} color={c.accent} strokeWidth={1.8} />
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.accent }}>{ETIQUETA_RAZONAR[chat.razonar]}</Text>
            </Pressable>
          )}

          <View style={{ flex: 1 }} />

          {chat.streaming ? (
            <Pressable
              onPress={chat.stop}
              accessibilityLabel="Detener"
              style={({ pressed }) => ({ width: 40, height: 40, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary, transform: [{ scale: pressed ? 0.94 : 1 }] })}
            >
              <Icon name="stop" size={16} color={c.onPrimary} />
            </Pressable>
          ) : (
            <Pressable
              onPress={onSend}
              disabled={!canSend}
              accessibilityLabel="Enviar"
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: RADIUS_SM,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: canSend ? c.accent : c.surface4,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              <Icon name="arrow-up" size={18} color={canSend ? c.onAccent : c.inkFaint} strokeWidth={1.8} />
            </Pressable>
          )}
        </View>
      </View>

      {ui.statusBar && chat.usage?.total > 0 && <ContextLine used={chat.usage.used} total={chat.usage.total} />}
    </View>
  );
}

const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} mil` : String(n));

/// Barra de estado (opcional en Personalizar): cuánto contexto lleva la
/// conversación respecto al máximo del modelo.
function ContextLine({ used, total }) {
  const c = useColors();
  const ratio = Math.min(1, used / total);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 24, paddingHorizontal: 6, marginTop: 4 }}>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: ratio >= 0.9 ? c.danger : c.inkMuted }}>
        Contexto {thousands(used)} de {thousands(total)}
      </Text>
      <Meter value={ratio} width={40} />
    </View>
  );
}
