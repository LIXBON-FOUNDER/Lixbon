// auth_screen.dart — login / registro / olvidé mi contraseña.
// Espejo móvil de la AuthPage de la web: toggle segmentado animado, campos
// flotantes, CTA pill y botones de Google/Apple (solo los configurados en el
// gateway — GET /api/auth/oauth/providers).
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  String mode = 'login'; // 'login' | 'register' | 'forgot'
  final firstName = TextEditingController();
  final lastName = TextEditingController();
  final email = TextEditingController();
  final password = TextEditingController();
  final confirm = TextEditingController();
  String error = '';
  String noticeLocal = '';
  bool busy = false;
  List<String> providers = [];

  @override
  void initState() {
    super.initState();
    _loadProviders();
  }

  @override
  void dispose() {
    firstName.dispose();
    lastName.dispose();
    email.dispose();
    password.dispose();
    confirm.dispose();
    super.dispose();
  }

  Future<void> _loadProviders() async {
    final api = context.read<ApiClient>();
    try {
      final data = await api.get('/api/auth/oauth/providers', auth: false);
      if (!mounted) return;
      setState(() {
        providers = (data is Map && data['providers'] is List)
            ? List<String>.from(data['providers'] as List)
            : [];
      });
    } catch (_) {
      // sin proveedores: los botones no se muestran
    }
  }

  void _switchMode(String next) {
    setState(() {
      mode = next;
      error = '';
      noticeLocal = '';
    });
    context.read<AuthState>().clearNotice();
  }

  Future<void> _submit() async {
    final auth = context.read<AuthState>();
    final api = context.read<ApiClient>();
    auth.clearNotice();
    setState(() {
      error = '';
      noticeLocal = '';
      busy = true;
    });
    try {
      if (mode == 'login') {
        await auth.login(email.text.trim(), password.text);
      } else if (mode == 'register') {
        if (password.text != confirm.text) {
          setState(() => error = 'Las contraseñas no coinciden');
          return;
        }
        await auth.register(
          firstName: firstName.text.trim(),
          lastName: lastName.text.trim(),
          email: email.text.trim(),
          password: password.text,
        );
      } else {
        await api.post('/api/auth/request-password-reset',
            auth: false, body: {'email': email.text.trim()});
        setState(() => noticeLocal =
            'Si el correo existe, te enviamos un enlace para restablecer la contraseña.');
      }
    } on ApiException catch (err) {
      setState(() => error = err.message);
    } catch (_) {
      setState(() => error = 'Algo salió mal. Intenta de nuevo.');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _withProvider(String provider) async {
    final auth = context.read<AuthState>();
    auth.clearNotice();
    setState(() {
      error = '';
      busy = true;
    });
    try {
      await auth.loginWithProvider(provider);
    } on ApiException catch (err) {
      if (!err.message.toLowerCase().contains('cancelado')) {
        setState(() => error = err.message);
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _changeServer() async {
    final prefs = context.read<PrefsState>();
    final value = await showPromptDialog(
      context,
      title: 'Servidor',
      message: 'URL base del gateway (solo para desarrollo).',
      placeholder: kDefaultApiBase,
      initialValue: prefs.apiBase,
      confirmLabel: 'Guardar',
    );
    if (value != null) {
      await prefs.setApiBase(value);
      _loadProviders();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    final notice = context.watch<AuthState>().notice;
    final dark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: c.bgSecondary,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 30),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Spark(size: 16, color: c.accentDeep),
                    const SizedBox(width: 14),
                    const LixLogo(size: 30),
                    const SizedBox(width: 14),
                    Spark(size: 16, color: c.accentDeep),
                  ],
                ),
                const SizedBox(height: 26),
                Container(
                  constraints: const BoxConstraints(maxWidth: 440),
                  padding: const EdgeInsets.all(22),
                  decoration: BoxDecoration(
                    color: c.bg,
                    borderRadius: BorderRadius.circular(kRadiusBox + 4),
                    border: Border.all(color: c.borderSoft),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (mode != 'forgot') _buildToggle(c),
                      if (mode == 'forgot')
                        Text(
                          'Restablecer contraseña',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: c.ink,
                            fontFamily: kFontUi,
                            fontWeight: FontWeight.w600,
                            fontSize: 19,
                          ),
                        ),
                      const SizedBox(height: 18),
                      if (mode == 'register') ...[
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: firstName,
                                textCapitalization: TextCapitalization.words,
                                style: TextStyle(color: c.ink, fontFamily: kFontUi),
                                decoration: lixInputDecoration(c, 'Nombre'),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: TextField(
                                controller: lastName,
                                textCapitalization: TextCapitalization.words,
                                style: TextStyle(color: c.ink, fontFamily: kFontUi),
                                decoration: lixInputDecoration(c, 'Apellido'),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 14),
                      ],
                      TextField(
                        controller: email,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        style: TextStyle(color: c.ink, fontFamily: kFontUi),
                        decoration: lixInputDecoration(c, 'Correo Electrónico'),
                      ),
                      if (mode != 'forgot') ...[
                        const SizedBox(height: 14),
                        TextField(
                          controller: password,
                          obscureText: true,
                          style: TextStyle(color: c.ink, fontFamily: kFontUi),
                          decoration: lixInputDecoration(c, 'Contraseña'),
                        ),
                      ],
                      if (mode == 'register') ...[
                        const SizedBox(height: 14),
                        TextField(
                          controller: confirm,
                          obscureText: true,
                          style: TextStyle(color: c.ink, fontFamily: kFontUi),
                          decoration: lixInputDecoration(c, 'Confirmar Contraseña'),
                        ),
                      ],
                      if (error.isNotEmpty || notice.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        Text(
                          error.isNotEmpty ? error : notice,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: c.danger, fontFamily: kFontUi, fontSize: 13),
                        ),
                      ],
                      if (noticeLocal.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        Text(
                          noticeLocal,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: c.accentDeep, fontFamily: kFontUi, fontSize: 13),
                        ),
                      ],
                      const SizedBox(height: 16),
                      pillButton(
                        c: c,
                        onPressed: busy ? null : _submit,
                        label: switch (mode) {
                          'register' => busy ? 'Creando cuenta…' : 'Crear Cuenta',
                          'forgot' => busy ? 'Enviando…' : 'Enviar enlace',
                          _ => busy ? 'Iniciando…' : 'Iniciar Sesión',
                        },
                      ),
                      const SizedBox(height: 12),
                      if (mode == 'login')
                        _link(c, '¿Olvidaste tu contraseña?', () => _switchMode('forgot')),
                      if (mode == 'forgot')
                        _link(c, 'Volver a iniciar sesión', () => _switchMode('login')),
                      if (mode != 'forgot' && providers.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Expanded(child: Divider(color: c.borderSoft)),
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 10),
                              child: Text(
                                mode == 'login' ? 'O inicia sesión con' : 'O regístrate con',
                                style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 12),
                              ),
                            ),
                            Expanded(child: Divider(color: c.borderSoft)),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            if (providers.contains('google'))
                              Expanded(child: _socialButton(c, 'Google', const GoogleLogo(), () => _withProvider('google'))),
                            if (providers.contains('google') && providers.contains('apple'))
                              const SizedBox(width: 10),
                            if (providers.contains('apple'))
                              Expanded(child: _socialButton(
                                c,
                                'Apple',
                                AppleLogo(color: dark ? Colors.white : Colors.black),
                                () => _withProvider('apple'),
                              )),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 22),
                // Mantener pulsado: cambiar de servidor (desarrollo)
                GestureDetector(
                  onLongPress: _changeServer,
                  child: Text(
                    'lixbon.com',
                    style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildToggle(LixColors c) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: c.bgSecondary,
        borderRadius: BorderRadius.circular(kRadiusPill),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final half = (constraints.maxWidth - 0) / 2;
          return Stack(
            children: [
              AnimatedPositioned(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                left: mode == 'register' ? half : 0,
                top: 0,
                bottom: 0,
                width: half,
                child: Container(
                  decoration: BoxDecoration(
                    color: c.primary,
                    borderRadius: BorderRadius.circular(kRadiusPill),
                  ),
                ),
              ),
              Row(
                children: [
                  _toggleButton(c, 'Iniciar Sesión', 'login'),
                  _toggleButton(c, 'Registrarse', 'register'),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _toggleButton(LixColors c, String label, String value) {
    final active = mode == value;
    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(kRadiusPill),
        onTap: () => _switchMode(value),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 11),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: active ? c.onPrimary : c.inkSoft,
              fontFamily: kFontUi,
              fontWeight: FontWeight.w500,
              fontSize: 14,
            ),
          ),
        ),
      ),
    );
  }

  Widget _link(LixColors c, String label, VoidCallback onTap) {
    return TextButton(
      onPressed: onTap,
      child: Text(
        label,
        style: TextStyle(
          color: c.inkSoft,
          fontFamily: kFontUi,
          fontSize: 13,
          decoration: TextDecoration.underline,
        ),
      ),
    );
  }

  Widget _socialButton(LixColors c, String label, Widget icon, VoidCallback onTap) {
    return OutlinedButton(
      onPressed: busy ? null : onTap,
      style: OutlinedButton.styleFrom(
        shape: const StadiumBorder(),
        side: BorderSide(color: c.borderSoft),
        padding: const EdgeInsets.symmetric(vertical: 13),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          icon,
          const SizedBox(width: 8),
          Text(
            label,
            style: TextStyle(color: c.ink, fontFamily: kFontUi, fontWeight: FontWeight.w500),
          ),
        ],
      ),
    );
  }
}
