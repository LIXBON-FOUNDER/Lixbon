// theme.dart — tokens de diseño de Lixbon (espejo de apps/web/src/styles/base.css
// y docs/DISENO_WEB.md): mismas paletas claro/oscuro y mismas fuentes.
import 'package:flutter/material.dart';

const kFontBrand = 'BrunoAceSC';
const kFontUi = 'BricolageGrotesque';
const kRadiusPill = 999.0;
const kRadiusBox = 22.0;

/// Paleta completa como ThemeExtension: `LixColors.of(context)`.
class LixColors extends ThemeExtension<LixColors> {
  final Color bg;
  final Color bgSidebar;
  final Color bgSecondary;
  final Color bgInput;
  final Color ink;
  final Color inkSoft;
  final Color inkMuted;
  final Color border;
  final Color borderSoft;
  final Color accent;
  final Color accentDeep;
  final Color accentSoft;
  final Color onAccent;
  final Color primary;
  final Color onPrimary;
  final Color codeBg;
  final Color codeInk;
  final Color scrim;
  final Color danger;
  final Color dangerSoft;
  final Color ok;

  const LixColors({
    required this.bg,
    required this.bgSidebar,
    required this.bgSecondary,
    required this.bgInput,
    required this.ink,
    required this.inkSoft,
    required this.inkMuted,
    required this.border,
    required this.borderSoft,
    required this.accent,
    required this.accentDeep,
    required this.accentSoft,
    required this.onAccent,
    required this.primary,
    required this.onPrimary,
    required this.codeBg,
    required this.codeInk,
    required this.scrim,
    required this.danger,
    required this.dangerSoft,
    required this.ok,
  });

  static const light = LixColors(
    bg: Color(0xFFFFFFFF),
    bgSidebar: Color(0xFFFFFFFF),
    bgSecondary: Color(0xFFF2F1E3),
    bgInput: Color(0xFFF2F1E3),
    ink: Color(0xFF171717),
    inkSoft: Color(0x9E171717), // 0.62
    inkMuted: Color(0x73171717), // 0.45
    border: Color(0xE6171717), // 0.9
    borderSoft: Color(0x29171717), // 0.16
    accent: Color(0xFFD9E64A),
    accentDeep: Color(0xFF6C7A46),
    accentSoft: Color(0x29D9E64A),
    onAccent: Color(0xFF171717),
    primary: Color(0xFF171717),
    onPrimary: Color(0xFFFFFFFF),
    codeBg: Color(0xFF171717),
    codeInk: Color(0xFFF6F7ED),
    scrim: Color(0x6B171717), // 0.42
    danger: Color(0xFFC0392B),
    dangerSoft: Color(0x1AC0392B),
    ok: Color(0xFF4A7C1A),
  );

  static const dark = LixColors(
    bg: Color(0xFF1A1913),
    bgSidebar: Color(0xFF141309),
    bgSecondary: Color(0xFF211F17),
    bgInput: Color(0xFF201E16),
    ink: Color(0xFFF3F0E2),
    inkSoft: Color(0xFFC3BCA6),
    inkMuted: Color(0xFF8E876F),
    border: Color(0xFF33301F),
    borderSoft: Color(0xFF2A2820),
    accent: Color(0xFFA9B86E),
    accentDeep: Color(0xFF6C7A46),
    accentSoft: Color(0x1AA9B86E),
    onAccent: Color(0xFF1A1913),
    primary: Color(0xFFF0EBD9),
    onPrimary: Color(0xFF1A1913),
    codeBg: Color(0xFF141309),
    codeInk: Color(0xFFC3BCA6),
    scrim: Color(0x99000000), // 0.6
    danger: Color(0xFFE0685A),
    dangerSoft: Color(0x24E0685A),
    ok: Color(0xFFA9B86E),
  );

  static LixColors of(BuildContext context) =>
      Theme.of(context).extension<LixColors>()!;

  @override
  LixColors copyWith() => this;

  @override
  LixColors lerp(ThemeExtension<LixColors>? other, double t) {
    if (other is! LixColors) return this;
    return t < 0.5 ? this : other;
  }
}

ThemeData buildTheme(Brightness brightness) {
  final c = brightness == Brightness.dark ? LixColors.dark : LixColors.light;
  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    fontFamily: kFontUi,
    scaffoldBackgroundColor: c.bg,
    colorScheme: ColorScheme(
      brightness: brightness,
      primary: c.primary,
      onPrimary: c.onPrimary,
      secondary: c.accentDeep,
      onSecondary: c.bg,
      error: c.danger,
      onError: Colors.white,
      surface: c.bg,
      onSurface: c.ink,
    ),
  );
  return base.copyWith(
    extensions: [c],
    dividerColor: c.borderSoft,
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.bgSidebar,
      indicatorColor: c.accentSoft,
      height: 64,
      labelTextStyle: WidgetStatePropertyAll(TextStyle(
        fontFamily: kFontUi,
        fontWeight: FontWeight.w500,
        fontSize: 11,
        color: c.inkSoft,
      )),
      iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(
            color: states.contains(WidgetState.selected) ? c.ink : c.inkMuted,
            size: 22,
          )),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: c.primary,
      contentTextStyle: TextStyle(fontFamily: kFontUi, color: c.onPrimary),
      behavior: SnackBarBehavior.floating,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.bg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadiusBox)),
      titleTextStyle: TextStyle(
        fontFamily: kFontUi,
        fontWeight: FontWeight.w600,
        fontSize: 17,
        color: c.ink,
      ),
      contentTextStyle: TextStyle(fontFamily: kFontUi, fontSize: 14, color: c.inkSoft),
    ),
  );
}
