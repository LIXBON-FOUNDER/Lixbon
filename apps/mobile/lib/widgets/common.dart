// common.dart — piezas compartidas: wordmark, iconos de marca (mismos paths
// SVG que la web), campos con etiqueta flotante, botones pill y diálogos.
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../theme.dart';

class LixLogo extends StatelessWidget {
  final double size;
  final Color? color;
  const LixLogo({super.key, this.size = 28, this.color});

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    return Text(
      'LIXBON',
      style: TextStyle(
        fontFamily: kFontBrand,
        fontSize: size,
        letterSpacing: size * 0.04,
        color: color ?? c.ink,
      ),
    );
  }
}

const _sparkPath = 'M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z';

class Spark extends StatelessWidget {
  final double size;
  final Color color;
  const Spark({super.key, this.size = 18, required this.color});

  @override
  Widget build(BuildContext context) {
    return SvgPicture.string(
      '<svg viewBox="0 0 24 24"><path fill="#000" d="$_sparkPath"/></svg>',
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
    );
  }
}

const _googleSvg = '''
<svg viewBox="0 0 24 24">
  <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/>
  <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/>
  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/>
</svg>
''';

const _appleSvgPath =
    'M16.36 12.79c-.03-2.53 2.07-3.74 2.16-3.8-1.18-1.72-3.01-1.96-3.66-1.99-1.56-.16-3.04.92-3.83.92-.79 0-2.01-.9-3.3-.87-1.7.02-3.27.99-4.14 2.5-1.77 3.07-.45 7.61 1.27 10.1.84 1.22 1.84 2.59 3.16 2.54 1.27-.05 1.75-.82 3.28-.82 1.53 0 1.96.82 3.3.79 1.36-.02 2.22-1.24 3.05-2.46.96-1.41 1.36-2.78 1.38-2.85-.03-.01-2.64-1.01-2.67-4.02zM13.84 5.35c.7-.85 1.17-2.03 1.04-3.21-1.01.04-2.23.67-2.95 1.52-.65.75-1.22 1.95-1.06 3.1 1.12.09 2.27-.57 2.97-1.41z';

class GoogleLogo extends StatelessWidget {
  final double size;
  const GoogleLogo({super.key, this.size = 19});

  @override
  Widget build(BuildContext context) =>
      SvgPicture.string(_googleSvg, width: size, height: size);
}

class AppleLogo extends StatelessWidget {
  final double size;
  final Color color;
  const AppleLogo({super.key, this.size = 19, required this.color});

  @override
  Widget build(BuildContext context) {
    return SvgPicture.string(
      '<svg viewBox="0 0 24 24"><path fill="#000" d="$_appleSvgPath"/></svg>',
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
    );
  }
}

/// Campo con etiqueta flotante: mismo lenguaje que el FloatingField de la web
/// (relleno bgInput, borde redondeado kRadiusBox, label que sube al foco).
InputDecoration lixInputDecoration(LixColors c, String label) {
  OutlineInputBorder border(Color color) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadiusBox),
        borderSide: BorderSide(color: color),
      );
  return InputDecoration(
    labelText: label,
    filled: true,
    fillColor: c.bgInput,
    labelStyle: TextStyle(color: c.inkMuted, fontFamily: kFontUi),
    floatingLabelStyle: TextStyle(color: c.ink, fontFamily: kFontUi),
    enabledBorder: border(c.borderSoft),
    focusedBorder: border(c.border),
    errorBorder: border(c.danger),
    focusedErrorBorder: border(c.danger),
    contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
  );
}

/// CTA pill (equivalente a .pill-btn--primary de la web).
Widget pillButton({
  required LixColors c,
  required String label,
  required VoidCallback? onPressed,
  bool danger = false,
  bool outline = false,
}) {
  final bg = danger ? c.danger : c.primary;
  final fg = danger ? Colors.white : c.onPrimary;
  if (outline) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        shape: const StadiumBorder(),
        side: BorderSide(color: danger ? c.danger : c.border),
        foregroundColor: danger ? c.danger : c.ink,
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
        textStyle: const TextStyle(fontFamily: kFontUi, fontWeight: FontWeight.w500, fontSize: 15),
      ),
      child: Text(label),
    );
  }
  return FilledButton(
    onPressed: onPressed,
    style: FilledButton.styleFrom(
      backgroundColor: bg,
      foregroundColor: fg,
      disabledBackgroundColor: bg.withValues(alpha: 0.45),
      disabledForegroundColor: fg.withValues(alpha: 0.7),
      shape: const StadiumBorder(),
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
      textStyle: const TextStyle(fontFamily: kFontUi, fontWeight: FontWeight.w500, fontSize: 15),
    ),
    child: Text(label),
  );
}

/// Diálogo con input opcional (renombrar, contraseña, servidor…).
/// Devuelve el texto introducido, o null si se canceló.
Future<String?> showPromptDialog(
  BuildContext context, {
  required String title,
  String? message,
  String? placeholder,
  String initialValue = '',
  bool secure = false,
  String confirmLabel = 'Aceptar',
  bool danger = false,
}) {
  final c = LixColors.of(context);
  final controller = TextEditingController(text: initialValue);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (message != null) ...[
            Text(message),
            const SizedBox(height: 14),
          ],
          TextField(
            controller: controller,
            obscureText: secure,
            autofocus: true,
            style: TextStyle(color: c.ink, fontFamily: kFontUi),
            decoration: lixInputDecoration(c, placeholder ?? ''),
            onSubmitted: (v) => Navigator.of(ctx).pop(v),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(),
          child: Text('Cancelar', style: TextStyle(color: c.inkSoft, fontFamily: kFontUi)),
        ),
        FilledButton(
          onPressed: () => Navigator.of(ctx).pop(controller.text),
          style: FilledButton.styleFrom(
            backgroundColor: danger ? c.danger : c.primary,
            foregroundColor: danger ? Colors.white : c.onPrimary,
            shape: const StadiumBorder(),
          ),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
}

/// Confirmación simple. Devuelve true si el usuario acepta.
Future<bool> showConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = 'Aceptar',
  bool danger = false,
}) async {
  final c = LixColors.of(context);
  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: Text('Cancelar', style: TextStyle(color: c.inkSoft, fontFamily: kFontUi)),
        ),
        FilledButton(
          onPressed: () => Navigator.of(ctx).pop(true),
          style: FilledButton.styleFrom(
            backgroundColor: danger ? c.danger : c.primary,
            foregroundColor: danger ? Colors.white : c.onPrimary,
            shape: const StadiumBorder(),
          ),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result == true;
}
