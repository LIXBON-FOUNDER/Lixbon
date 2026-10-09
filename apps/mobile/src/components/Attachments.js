// Attachments.js — adjuntos del compositor (chat y control remoto): selector
// de origen, lectura en segundo plano y las miniaturas que se ven mientras.
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';

import { pickDocuments, pickImages, readAttachment } from '../attachments';
import { useApi } from '../state';
import { FONTS, RADIUS_SM } from '../theme';
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

  const pickFrom = useCallback(
    async (source) => {
      try {
        const files = source === 'doc' ? await pickDocuments() : await pickImages({ camera: source === 'camera' });
        addFiles(files);
      } catch (err) {
        toast(err?.message || 'No se pudo abrir el selector');
      }
    },
    [toast, addFiles],
  );

  const pick = useCallback(async () => {
    const source = await sheet({
      title: 'Adjuntar',
      subtitle: allowImages ? 'documentos, imágenes o una foto' : 'este equipo solo recibe documentos',
      items: [
        { label: 'Documento', description: 'PDF, Word, Excel, texto o código', icon: 'file', value: 'doc' },
        ...(allowImages
          ? [
              { label: 'Imagen de la galería', description: 'Fotos y capturas del teléfono', icon: 'image', value: 'gallery' },
              { label: 'Hacer una foto', description: 'Abre la cámara', icon: 'camera', value: 'camera' },
            ]
          : []),
      ],
    });
    if (source) pickFrom(source);
  }, [sheet, pickFrom, allowImages]);

  const remove = useCallback((id) => setItems((prev) => prev.filter((a) => a.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);

  return {
    items,
    ready: items.filter((a) => a.status === 'ready'),
    reading: items.some((a) => a.status === 'reading'),
    pick,
    pickFrom,
    addFiles,
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
      contentContainerStyle={{ gap: 8, paddingBottom: 10 }}
    >
      {extra}
      {items.map((a) => (
        <AttachmentChip key={a.id} item={a} onRemove={() => onRemove(a.id)} />
      ))}
    </ScrollView>
  );
}

/// Imagen: miniatura cuadrada con la equis encima. Documento: ficha con el
/// nombre y el tipo. Mientras se lee, el giro reemplaza la acción de quitar.
export function AttachmentChip({ item, onRemove }) {
  const c = useColors();
  const reading = item.status === 'reading';
  if (item.preview) {
    return (
      <View style={{ width: 64, height: 64, borderRadius: RADIUS_SM, overflow: 'hidden', backgroundColor: c.surface4 }}>
        <Image source={{ uri: item.preview }} style={{ width: 64, height: 64, opacity: reading ? 0.45 : 1 }} />
        {reading ? (
          <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="small" color={c.ink} />
          </View>
        ) : (
          <Pressable
            onPress={onRemove}
            hitSlop={8}
            accessibilityLabel={`Quitar ${item.name}`}
            style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(14,14,14,0.82)' }}
          >
            <Icon name="x" size={11} color="#F2F2F0" strokeWidth={2.2} />
          </Pressable>
        )}
      </View>
    );
  }
  const ext = (item.name.split('.').pop() || '').toUpperCase();
  return (
    <View style={{ maxWidth: 230, height: 64, paddingLeft: 12, paddingRight: reading ? 14 : 4, borderRadius: RADIUS_SM, backgroundColor: c.surface4, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon name="file" size={20} color={c.inkSoft} />
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.ink }}>
          {item.name}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkMuted }}>
          {reading ? 'Leyendo…' : ext || 'Documento'}
        </Text>
      </View>
      {reading ? (
        <ActivityIndicator size="small" color={c.inkSoft} />
      ) : (
        <Pressable onPress={onRemove} hitSlop={6} accessibilityLabel={`Quitar ${item.name}`} style={({ pressed }) => ({ width: 32, height: 32, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}>
          <Icon name="x" size={14} color={c.inkMuted} />
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
        height: 64,
        paddingLeft: 12,
        paddingRight: 4,
        borderRadius: RADIUS_SM,
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
