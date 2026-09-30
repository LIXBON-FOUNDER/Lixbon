// markdown.js — estilos de las respuestas en Markdown (chat y control remoto).
import { FONTS, RADIUS } from '../theme';

export function markdownStyles(c, t) {
  // react-native-markdown-display trae borde gris por defecto en el código.
  const code = { fontFamily: FONTS.mono, fontSize: t(12.5), lineHeight: t(19), color: c.inkBody, borderWidth: 0 };
  return {
    body: { fontFamily: FONTS.ui, fontSize: t(15), lineHeight: t(23), color: c.inkBody },
    heading1: { fontFamily: FONTS.uiSemiBold, fontSize: t(19), color: c.ink, marginTop: 8, marginBottom: 4 },
    heading2: { fontFamily: FONTS.uiSemiBold, fontSize: t(17), color: c.ink, marginTop: 8, marginBottom: 4 },
    heading3: { fontFamily: FONTS.uiSemiBold, fontSize: t(15.5), color: c.ink, marginTop: 6, marginBottom: 3 },
    strong: { fontFamily: FONTS.uiBold, color: c.ink },
    em: { fontStyle: 'italic', color: c.ink },
    link: { color: c.accentDeep, textDecorationLine: 'underline' },
    bullet_list_icon: { color: c.accentDeep },
    ordered_list_icon: { color: c.inkLabel, fontFamily: FONTS.mono },
    blockquote: { backgroundColor: c.surface2, borderLeftWidth: 2, borderLeftColor: c.accent, borderRadius: RADIUS, paddingHorizontal: 12, marginVertical: 4 },
    code_inline: { ...code, color: c.accentDeep, backgroundColor: c.surface3, borderRadius: 4, paddingHorizontal: 4 },
    code_block: { ...code, backgroundColor: c.codeBg, borderRadius: RADIUS, padding: 12, marginVertical: 6 },
    fence: { ...code, backgroundColor: c.codeBg, borderRadius: RADIUS, padding: 12, marginVertical: 6 },
    hr: { backgroundColor: c.surface4, height: 1, marginVertical: 10 },
    table: { borderColor: c.surface4, borderWidth: 1, borderRadius: RADIUS },
    th: { fontFamily: FONTS.uiSemiBold, fontSize: t(13), color: c.ink, padding: 6 },
    td: { fontFamily: FONTS.ui, fontSize: t(13), color: c.inkBody, padding: 6 },
    tr: { borderColor: c.surface4 },
  };
}
