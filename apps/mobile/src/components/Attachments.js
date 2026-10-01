// Attachments.js — adjuntos del compositor (chat y control remoto): selector
// de origen, lectura en segundo plano y las fichas que se ven mientras tanto.
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';

import { pickDocuments, pickImages, readAttachment } from '../attachments';
import { useApi } from '../state';
import { FONTS, RADIUS } from '../theme';
import Icon from './Icon';
import { useDialogs } from './dialogs';
import { useColors } from './ui';

export function useAttachments({ describeImages = true, allowImages = true } = {}) {
  const api = useApi();
  const { sheet, toast } = useDialogs();
  const [items, setItems] = useState([]);

  const addFiles = useCallback(
    async (files) => {
      for (const file of files) {
        if (file.kind === 'image' && !allowImages) {
          toast(`${file.name}: este agente no recibe imágenes`);
          continue;
        }
        const id = `${Date.now()}-${Math.random()}`;
        setItems((prev) => [
          ...prev,
          { ...file, id, status: 'reading', describe: describeImages, preview: file.kind === 'image' ? file.uri : null },
        ]);
        try {
          const result = await readAttachment(api, file, { describeImages });
          setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...result, status: 'ready' } : a)));
          if (result.truncated) toast(`${file.name}: solo se usará el principio del texto`);
        } catch (err) {
          setItems((prev) => prev.filter((a) => a.id !== id));
          toast(`${file.name}: ${err?.message || 'no se pudo adjuntar'}`);
        }
      }
    },
    [api, describeImages, allowImages, toast],
  );

  const pick = useCallback(async () => {
    const source = await sheet({
      title: 'Adjuntar',
      items: [
        { label: 'Documento', icon: 'file', value: 'doc' },
        ...(allowImages
          ? [
              { label: 'Imagen de la galería', icon: 'image', value: 'gallery' },
              { label: 'Hacer una foto', icon: 'camera', value: 'camera' },
            ]
          : []),
      ],
    });
    if (!source) return;
    try {
      const files = source === 'doc' ? await pickDocuments() : await pickImages({ camera: source === 'camera' });
      addFiles(files);
    } catch (err) {
      toast(err?.message || 'No se pudo abrir el selector');
    }
  }, [sheet, toast, addFiles, allowImages]);

  const remove = useCallback((id) => setItems((prev) => prev.filter((a) => a.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);

  return {
    items,
    ready: items.filter((a) => a.status === 'ready'),
    reading: items.some((a) => a.status === 'reading'),
    pick,
    remove,
    clear,
  };
}

export function AttachmentTray({ items, onRemove, extra = null }) {
  if (items.length === 0 && !extra) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 6, paddingBottom: 8 }}
    >
      {extra}
      {items.map((a) => (
        <AttachmentChip key={a.id} item={a} onRemove={() => onRemove(a.id)} />
      ))}
    </ScrollView>
  );
}

export function AttachmentChip({ item, onRemove }) {
  const c = useColors();
  const reading = item.status === 'reading';
  const kindLabel = item.kind === 'image' ? 'imagen' : 'documento';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        maxWidth: 200,
        height: 40,
        paddingLeft: item.preview ? 4 : 10,
        paddingRight: 4,
        borderRadius: RADIUS,
        backgroundColor: c.surface5,
      }}
    >
      {item.preview ? (
        <Image source={{ uri: item.preview }} style={{ width: 32, height: 32, borderRadius: 5, opacity: reading ? 0.5 : 1 }} />
      ) : (
        <Icon name="file" size={15} color={c.accentDeep} />
      )}
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 12, color: c.ink }}>
          {item.name}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.mono, fontSize: 9.5, color: c.inkLabel }}>
          {reading ? (item.kind !== 'image' ? 'leyendo…' : item.describe ? 'describiendo…' : 'preparando…') : kindLabel}
        </Text>
      </View>
      {reading ? (
        <ActivityIndicator size="small" color={c.accent} style={{ marginHorizontal: 6 }} />
      ) : (
        <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Quitar ${item.name}`} style={{ padding: 6 }}>
          <Icon name="x" size={13} color={c.inkSoft} />
        </Pressable>
      )}
    </View>
  );
}

// Ficha de una mención @archivo (control remoto): mismo lenguaje que un adjunto.
export function MentionChip({ mention, onRemove }) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: 220,
        height: 40,
        paddingLeft: 10,
        paddingRight: 4,
        borderRadius: RADIUS,
        backgroundColor: c.accentSoft,
      }}
    >
      <Text style={{ fontFamily: FONTS.monoMedium, fontSize: 12, color: c.accentDeep }}>@</Text>
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 12, color: c.ink }}>
          {mention.name}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.mono, fontSize: 9.5, color: c.inkLabel }}>
          {mention.rel}
        </Text>
      </View>
      <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Quitar ${mention.name}`} style={{ padding: 6 }}>
        <Icon name="x" size={13} color={c.inkSoft} />
      </Pressable>
    </View>
  );
}
