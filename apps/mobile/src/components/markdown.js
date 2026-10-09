// markdown.js — estilos y reglas de las respuestas en Markdown (chat y control
// remoto). Los bloques de código llevan cabecera con el lenguaje y copiar.
import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { FONTS, RADIUS, RADIUS_SM } from '../theme';
import Icon from './Icon';

export function markdownStyles(c, t) {
  // react-native-markdown-display trae borde gris por defecto en el código.
  const code = { fontFamily: FONTS.mono, fontSize: t(13), lineHeight: t(20.8), color: c.inkBody, borderWidth: 0 };
  return {
    body: { fontFamily: FONTS.ui, fontSize: t(15), lineHeight: t(22.5), color: c.inkBody },
    paragraph: { marginTop: 0, marginBottom: 12 },
    heading1: { fontFamily: FONTS.uiSemiBold, fontSize: t(19), color: c.ink, marginTop: 6, marginBottom: 8 },
    heading2: { fontFamily: FONTS.uiSemiBold, fontSize: t(17), color: c.ink, marginTop: 6, marginBottom: 8 },
    heading3: { fontFamily: FONTS.uiSemiBold, fontSize: t(15.5), color: c.ink, marginTop: 4, marginBottom: 6 },
    strong: { fontFamily: FONTS.uiSemiBold, fontWeight: 'normal', color: c.ink },
    em: { fontStyle: 'italic', color: c.ink },
    link: { color: c.accent, textDecorationLine: 'underline' },
    bullet_list: { marginBottom: 12 },
    ordered_list: { marginBottom: 12 },
    list_item: { marginBottom: 6 },
    bullet_list_icon: { color: c.inkMuted, marginLeft: 4, marginRight: 8 },
    ordered_list_icon: { color: c.inkMuted, fontFamily: FONTS.ui, marginRight: 8 },
    blockquote: { backgroundColor: 'transparent', borderLeftWidth: 2, borderLeftColor: c.surface6, paddingHorizontal: 12, marginVertical: 4 },
    code_inline: { ...code, fontSize: t(13.5), color: c.ink, backgroundColor: c.surface3, borderRadius: 4, paddingHorizontal: 4 },
    code_block: { ...code, backgroundColor: c.codeBg, borderRadius: RADIUS, padding: 12, marginVertical: 6 },
    fence: { ...code, backgroundColor: c.codeBg, borderRadius: RADIUS, padding: 12, marginVertical: 6 },
    hr: { backgroundColor: c.borderSoft, height: 1, marginVertical: 12 },
    table: { borderColor: c.surface4, borderWidth: 1, borderRadius: RADIUS, marginBottom: 12 },
    th: { fontFamily: FONTS.uiMedium, fontSize: t(13.5), color: c.ink, padding: 8 },
    td: { fontFamily: FONTS.ui, fontSize: t(13.5), color: c.inkBody, padding: 8 },
    tr: { borderColor: c.surface4 },
  };
}

function CodeBlock({ code, lang, c, t, onCopied }) {
  return (
    <View style={{ borderRadius: RADIUS, backgroundColor: c.codeBg, overflow: 'hidden', marginBottom: 12 }}>
      <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4 }}>
        <Text style={{ flex: 1, fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{lang || 'código'}</Text>
        <Pressable
          accessibilityLabel="Copiar código"
          hitSlop={6}
          onPress={async () => {
            await Clipboard.setStringAsync(code);
            onCopied?.();
          }}
          style={({ pressed }) => ({ width: 32, height: 32, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}
        >
          <Icon name="copy" size={15} color={c.inkMuted} />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}>
        <Text selectable style={{ fontFamily: FONTS.mono, fontSize: t(13), lineHeight: t(20.8), color: c.inkBody }}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

export function markdownRules(c, t, onCopied) {
  const block = (node) => (
    <CodeBlock key={node.key} code={String(node.content || '').replace(/\n$/, '')} lang={String(node.sourceInfo || '').trim().split(/\s+/)[0]} c={c} t={t} onCopied={onCopied} />
  );
  return { fence: block, code_block: block };
}
