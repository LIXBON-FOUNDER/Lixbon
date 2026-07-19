// account_screen.dart — todo lo del usuario: perfil, verificación de correo,
// tema, privacidad, API key, documentación (abre la web), borrado de
// historial, cierre de sesión y eliminación de cuenta.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';

class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key});

  void _snack(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _editName(BuildContext context) async {
    final api = context.read<ApiClient>();
    final auth = context.read<AuthState>();
    final user = auth.user ?? {};
    final current = [user['first_name'], user['last_name']]
        .whereType<String>()
        .where((s) => s.isNotEmpty)
        .join(' ');
    final value = await showPromptDialog(
      context,
      title: 'Tu nombre',
      message: 'Nombre y apellido separados por un espacio.',
      placeholder: 'Nombre Apellido',
      initialValue: current,
      confirmLabel: 'Guardar',
    );
    final trimmed = value?.trim() ?? '';
    if (trimmed.isEmpty) return;
    final parts = trimmed.split(RegExp(r'\s+'));
    final firstName = parts.first;
    final lastName = parts.length > 1
        ? parts.sublist(1).join(' ')
        : ((user['last_name'] as String?) ?? '');
    try {
      await api.patch('/api/account/profile',
          body: {'first_name': firstName, 'last_name': lastName});
      await auth.refreshMe();
    } on ApiException catch (err) {
      if (context.mounted) _snack(context, err.message);
    }
  }

  Future<void> _toggleSetting(BuildContext context, String key, bool value) async {
    final api = context.read<ApiClient>();
    final auth = context.read<AuthState>();
    try {
      await api.patch('/api/account/settings', body: {key: value});
      await auth.refreshMe();
    } on ApiException catch (err) {
      if (context.mounted) _snack(context, err.message);
    }
  }

  Future<void> _resendVerification(BuildContext context) async {
    final api = context.read<ApiClient>();
    try {
      final res = await api.post('/api/auth/resend-verification');
      if (context.mounted) {
        _snack(context, (res is Map ? res['message'] : null)?.toString() ?? 'Correo enviado');
      }
    } on ApiException catch (err) {
      if (context.mounted) _snack(context, err.message);
    }
  }

  Future<void> _regenerateKey(BuildContext context) async {
    final api = context.read<ApiClient>();
    final auth = context.read<AuthState>();
    final ok = await showConfirmDialog(
      context,
      title: 'Regenerar API key',
      message: 'Tu key actual dejará de funcionar en todos los dispositivos '
          '(esta app adoptará la nueva automáticamente).',
      confirmLabel: 'Regenerar',
      danger: true,
    );
    if (!ok) return;
    try {
      final res = await api.post('/api/auth/api-key/regenerate');
      final newKey = (res is Map ? res['newApiKey'] : null);
      if (newKey is String && newKey.isNotEmpty) {
        await auth.adoptApiKey(newKey);
      }
      if (context.mounted) {
        _snack(context, 'API key regenerada. Esta app ya usa la nueva.');
      }
    } on ApiException catch (err) {
      if (context.mounted) _snack(context, err.message);
    }
  }

  Future<void> _clearHistory(BuildContext context) async {
    final api = context.read<ApiClient>();
    final chat = context.read<ChatState>();
    final ok = await showConfirmDialog(
      context,
      title: 'Borrar historial',
      message: 'Se eliminarán TODAS tus conversaciones. '
          'Esta acción no se puede deshacer.',
      confirmLabel: 'Borrar todo',
      danger: true,
    );
    if (!ok) return;
    try {
      await api.delete('/api/account/conversations');
      chat.newChat();
      if (context.mounted) _snack(context, 'Historial eliminado.');
    } on ApiException catch (err) {
      if (context.mounted) _snack(context, err.message);
    }
  }

  Future<void> _deleteAccount(BuildContext context) async {
    final api = context.read<ApiClient>();
    final auth = context.read<AuthState>();
    final password = await showPromptDialog(
      context,
      title: 'Eliminar cuenta',
      message: 'Se borrarán tu cuenta, historial y claves de forma definitiva. '
          'Escribe tu contraseña para confirmar. (Si entraste con Google/Apple, '
          'primero crea una contraseña con "¿Olvidaste tu contraseña?").',
      placeholder: 'Contraseña',
      secure: true,
      confirmLabel: 'Eliminar',
      danger: true,
    );
    if (password == null || password.isEmpty) return;
    try {
      await api.delete('/api/account', body: {'password': password});
      await auth.logout(withNotice: 'Tu cuenta fue eliminada.');
    } on ApiException catch (err) {
      if (context.mounted) _snack(context, err.message);
    }
  }

  Future<void> _logout(BuildContext context) async {
    final auth = context.read<AuthState>();
    final ok = await showConfirmDialog(
      context,
      title: 'Cerrar sesión',
      message: '¿Salir de tu cuenta en este dispositivo?',
      confirmLabel: 'Cerrar sesión',
      danger: true,
    );
    if (ok) await auth.logout();
  }

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    final auth = context.watch<AuthState>();
    final prefs = context.watch<PrefsState>();
    final api = context.read<ApiClient>();
    final user = auth.user ?? {};
    final settings = (user['settings'] is Map)
        ? Map<String, dynamic>.from(user['settings'] as Map)
        : <String, dynamic>{};

    final fullName = [user['first_name'], user['last_name']]
        .whereType<String>()
        .where((s) => s.isNotEmpty)
        .join(' ');
    final email = (user['email'] as String?) ?? '';
    final initialsSource = fullName.isNotEmpty ? fullName : email;
    final initials = initialsSource.isNotEmpty
        ? initialsSource
            .split(RegExp(r'\s+'))
            .where((s) => s.isNotEmpty)
            .take(2)
            .map((s) => s[0].toUpperCase())
            .join()
        : '?';

    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 40),
          children: [
            Text(
              'Cuenta',
              style: TextStyle(
                color: c.ink,
                fontFamily: kFontUi,
                fontWeight: FontWeight.w600,
                fontSize: 22,
              ),
            ),
            const SizedBox(height: 16),

            // Perfil
            _card(c, background: c.bgSecondary, children: [
              Row(
                children: [
                  CircleAvatar(
                    radius: 26,
                    backgroundColor: c.primary,
                    child: Text(
                      initials,
                      style: TextStyle(
                        color: c.onPrimary,
                        fontFamily: kFontUi,
                        fontWeight: FontWeight.w600,
                        fontSize: 18,
                      ),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          fullName.isNotEmpty
                              ? fullName
                              : ((user['username'] as String?) ?? '—'),
                          style: TextStyle(
                            color: c.ink,
                            fontFamily: kFontUi,
                            fontWeight: FontWeight.w600,
                            fontSize: 16,
                          ),
                        ),
                        Text(
                          email,
                          style: TextStyle(
                              color: c.inkSoft, fontFamily: kFontUi, fontSize: 13),
                        ),
                        if (user['plan_name'] is String) ...[
                          const SizedBox(height: 4),
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 3),
                            decoration: BoxDecoration(
                              color: c.accent,
                              borderRadius: BorderRadius.circular(kRadiusPill),
                            ),
                            child: Text(
                              user['plan_name'] as String,
                              style: TextStyle(
                                color: c.onAccent,
                                fontFamily: kFontUi,
                                fontWeight: FontWeight.w500,
                                fontSize: 11,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => _editName(context),
                    style: IconButton.styleFrom(backgroundColor: c.bg),
                    icon: Icon(Icons.edit, size: 16, color: c.ink),
                  ),
                ],
              ),
              if (user.isNotEmpty && user['email_verified'] != true) ...[
                const SizedBox(height: 10),
                InkWell(
                  onTap: () => _resendVerification(context),
                  borderRadius: BorderRadius.circular(12),
                  child: Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: c.accentSoft,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.mark_email_unread_outlined,
                            size: 15, color: c.accentDeep),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Correo sin verificar — toca para reenviar el enlace',
                            style: TextStyle(
                              color: c.accentDeep,
                              fontFamily: kFontUi,
                              fontWeight: FontWeight.w500,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ]),
            const SizedBox(height: 16),

            // Apariencia
            _card(c, children: [
              _section(c, 'Apariencia'),
              const SizedBox(height: 8),
              Row(
                children: [
                  _themeChip(c, prefs, 'Auto', ThemeMode.system),
                  const SizedBox(width: 8),
                  _themeChip(c, prefs, 'Claro', ThemeMode.light),
                  const SizedBox(width: 8),
                  _themeChip(c, prefs, 'Oscuro', ThemeMode.dark),
                ],
              ),
            ]),
            const SizedBox(height: 16),

            // Privacidad
            _card(c, children: [
              _section(c, 'Privacidad'),
              _switchRow(
                context,
                c,
                icon: Icons.save_outlined,
                label: 'Guardar historial',
                value: settings['save_history'] != false,
                onChanged: (v) => _toggleSetting(context, 'save_history', v),
              ),
              _switchRow(
                context,
                c,
                icon: Icons.insights_outlined,
                label: 'Métricas anónimas',
                value: settings['anonymous_usage'] != false,
                onChanged: (v) => _toggleSetting(context, 'anonymous_usage', v),
              ),
            ]),
            const SizedBox(height: 16),

            // Recursos y seguridad
            _card(c, children: [
              _actionRow(c,
                  icon: Icons.menu_book_outlined,
                  label: 'Documentación',
                  onTap: () => launchUrl(Uri.parse('${api.base}/docs'),
                      mode: LaunchMode.externalApplication)),
              Divider(height: 1, color: c.borderSoft),
              _actionRow(c,
                  icon: Icons.key_outlined,
                  label: 'Regenerar API key',
                  onTap: () => _regenerateKey(context)),
              Divider(height: 1, color: c.borderSoft),
              _actionRow(c,
                  icon: Icons.delete_outline,
                  label: 'Borrar historial de conversaciones',
                  onTap: () => _clearHistory(context)),
            ]),
            const SizedBox(height: 16),

            // Sesión
            _card(c, children: [
              _actionRow(c,
                  icon: Icons.logout,
                  label: 'Cerrar sesión',
                  onTap: () => _logout(context)),
              Divider(height: 1, color: c.borderSoft),
              _actionRow(c,
                  icon: Icons.warning_amber_outlined,
                  label: 'Eliminar cuenta',
                  danger: true,
                  onTap: () => _deleteAccount(context)),
            ]),
            const SizedBox(height: 20),

            Center(
              child: Text(
                'Lixbon móvil · v0.1.0',
                style:
                    TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 11),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card(LixColors c, {Color? background, required List<Widget> children}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: background ?? c.bg,
        borderRadius: BorderRadius.circular(kRadiusBox),
        border: Border.all(color: c.borderSoft),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
    );
  }

  Widget _section(LixColors c, String text) => Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 2),
        child: Text(
          text.toUpperCase(),
          style: TextStyle(
            color: c.inkSoft,
            fontFamily: kFontUi,
            fontWeight: FontWeight.w600,
            fontSize: 12,
            letterSpacing: 0.6,
          ),
        ),
      );

  Widget _switchRow(
    BuildContext context,
    LixColors c, {
    required IconData icon,
    required String label,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2, horizontal: 4),
      child: Row(
        children: [
          Icon(icon, size: 19, color: c.inkSoft),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: c.ink,
                fontFamily: kFontUi,
                fontWeight: FontWeight.w500,
                fontSize: 14,
              ),
            ),
          ),
          Switch(
            value: value,
            onChanged: onChanged,
            activeTrackColor: c.accentDeep,
            inactiveTrackColor: c.borderSoft,
          ),
        ],
      ),
    );
  }

  Widget _actionRow(
    LixColors c, {
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    bool danger = false,
  }) {
    final color = danger ? c.danger : c.ink;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 13, horizontal: 4),
        child: Row(
          children: [
            Icon(icon, size: 19, color: danger ? c.danger : c.inkSoft),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                style: TextStyle(
                  color: color,
                  fontFamily: kFontUi,
                  fontWeight: FontWeight.w500,
                  fontSize: 14,
                ),
              ),
            ),
            Icon(Icons.chevron_right, size: 16, color: c.inkMuted),
          ],
        ),
      ),
    );
  }

  Widget _themeChip(LixColors c, PrefsState prefs, String label, ThemeMode mode) {
    final active = prefs.themeMode == mode;
    return InkWell(
      borderRadius: BorderRadius.circular(kRadiusPill),
      onTap: () => prefs.setThemeMode(mode),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 9),
        decoration: BoxDecoration(
          color: active ? c.primary : c.bgSecondary,
          borderRadius: BorderRadius.circular(kRadiusPill),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: active ? c.onPrimary : c.inkSoft,
            fontFamily: kFontUi,
            fontWeight: FontWeight.w500,
            fontSize: 13,
          ),
        ),
      ),
    );
  }
}
