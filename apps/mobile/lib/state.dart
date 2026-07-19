// state.dart — estado global con ChangeNotifier + provider:
//   PrefsState  → tema y servidor (SharedPreferences; nunca credenciales)
//   AuthState   → sesión (API key "Lixbon Mobile" en el Keystore vía
//                 flutter_secure_storage) — se rota en cada login
//   ChatState   → modelos, conversación activa y streaming
import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'oauth.dart';
import 'sse.dart';

const kDefaultApiBase = 'https://lixbon.com';
const _kSecureKey = 'lixbon_api_key';
const _kMobileKeyName = 'Lixbon Mobile';

// ── Preferencias locales ───────────────────────────────────────────────────

class PrefsState extends ChangeNotifier {
  ThemeMode themeMode = ThemeMode.system;
  String apiBase = kDefaultApiBase;

  Future<void> hydrate() async {
    final prefs = await SharedPreferences.getInstance();
    final mode = prefs.getString('themeMode');
    themeMode = switch (mode) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
    apiBase = prefs.getString('apiBase') ?? kDefaultApiBase;
    notifyListeners();
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    themeMode = mode;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('themeMode', switch (mode) {
      ThemeMode.light => 'light',
      ThemeMode.dark => 'dark',
      ThemeMode.system => 'system',
    });
  }

  Future<void> setApiBase(String value) async {
    final cleaned = value.trim().replaceAll(RegExp(r'/+$'), '');
    apiBase = cleaned.isEmpty ? kDefaultApiBase : cleaned;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('apiBase', apiBase);
  }
}

// ── Sesión ─────────────────────────────────────────────────────────────────

class AuthState extends ChangeNotifier {
  final ApiClient api;
  final _storage = const FlutterSecureStorage();

  bool ready = false;
  String? apiKey;
  Map<String, dynamic>? user;
  String notice = ''; // aviso post-logout ("tu sesión expiró…")

  AuthState(this.api);

  Future<void> hydrate() async {
    try {
      final key = await _storage.read(key: _kSecureKey);
      if (key != null && key.isNotEmpty) {
        apiKey = key;
        await refreshMe(); // valida la key; un 401 dispara sessionExpired
      }
    } catch (_) {
      // Keystore no disponible: se queda deslogueado
    }
    ready = true;
    notifyListeners();
  }

  Future<void> refreshMe() async {
    try {
      final data = await api.get('/api/auth/me');
      if (data is Map && data['user'] is Map) {
        user = Map<String, dynamic>.from(data['user'] as Map);
        notifyListeners();
      }
    } on ApiException {
      // el 401 ya deslogueó vía onUnauthorized; otros errores no tumban la sesión
    }
  }

  Future<void> _adoptLogin(Map<String, dynamic> data) async {
    final key = data['api_key'];
    if (key is! String || key.isEmpty) {
      throw ApiException('El servidor no entregó credenciales para la app');
    }
    await _storage.write(key: _kSecureKey, value: key);
    apiKey = key;
    if (data['user'] is Map) {
      user = Map<String, dynamic>.from(data['user'] as Map);
    }
    notice = '';
    notifyListeners();
    unawaited(refreshMe()); // trae plan y settings completos
  }

  Future<void> login(String email, String password) async {
    final data = await api.post('/api/auth/login', auth: false, body: {
      'email': email,
      'password': password,
      'issue_api_key': true,
      'key_name': _kMobileKeyName,
    });
    await _adoptLogin(Map<String, dynamic>.from(data as Map));
  }

  Future<void> register({
    required String firstName,
    required String lastName,
    required String email,
    required String password,
  }) async {
    await api.post('/api/auth/register', auth: false, body: {
      'first_name': firstName,
      'last_name': lastName,
      'email': email,
      'password': password,
    });
    // El registro entrega cookie de sesión (web); la app necesita su API key,
    // así que encadena un login normal con las mismas credenciales.
    await login(email, password);
  }

  Future<void> loginWithProvider(String provider) async {
    final result = await oauthAuthorize(provider, api.base);
    final data = await api.post('/api/auth/oauth/exchange', auth: false, body: {
      'code': result.code,
      'code_verifier': result.verifier,
      'issue_api_key': true,
      'key_name': _kMobileKeyName,
    });
    await _adoptLogin(Map<String, dynamic>.from(data as Map));
  }

  /// La regeneración desde Cuenta devuelve una key nueva: se adopta al instante.
  Future<void> adoptApiKey(String rawKey) async {
    await _storage.write(key: _kSecureKey, value: rawKey);
    apiKey = rawKey;
    notifyListeners();
  }

  void sessionExpired() {
    logout(withNotice: 'Tu sesión expiró. Inicia sesión de nuevo.');
  }

  Future<void> logout({String withNotice = ''}) async {
    try {
      await _storage.delete(key: _kSecureKey);
    } catch (_) {
      // ya borrada
    }
    apiKey = null;
    user = null;
    notice = withNotice;
    notifyListeners();
  }

  void clearNotice() {
    if (notice.isNotEmpty) {
      notice = '';
      notifyListeners();
    }
  }
}

// ── Chat ───────────────────────────────────────────────────────────────────

class ChatMessage {
  final String role;
  String content;
  List<dynamic>? sources;
  ChatMessage(this.role, this.content, {this.sources});
}

class ChatState extends ChangeNotifier {
  final ApiClient api;
  final AuthState auth;

  List<String> models = [];
  String model = '';
  String? conversationId;
  String? title;
  List<ChatMessage> messages = [];
  bool streaming = false;
  bool loadingMessages = false;
  String error = '';
  bool webSearch = false;
  String draft = ''; // texto del compositor (sobrevive al cambio de pestaña)

  ChatStreamHandle? _handle;
  bool _hadHistory = false; // la conversación ya existía (no pedir auto-título)

  ChatState(this.api, this.auth);

  Future<void> loadModels() async {
    try {
      final res = await api.get('/v1/models');
      final list = (res is Map ? res['data'] : null);
      final ids = <String>[];
      if (list is List) {
        for (final m in list) {
          final id = (m is Map ? m['id'] : null);
          if (id is String && !id.startsWith('error:')) ids.add(id);
        }
      }
      models = ids;
      if (model.isEmpty || !ids.contains(model)) {
        model = ids.isNotEmpty ? ids.first : '';
      }
    } catch (_) {
      models = [];
    }
    notifyListeners();
  }

  void setModel(String value) {
    model = value;
    notifyListeners();
  }

  void setWebSearch(bool value) {
    webSearch = value;
    notifyListeners();
  }

  void setDraft(String value) {
    draft = value; // sin notify: el TextField ya refleja el valor
  }

  void clearError() {
    error = '';
    notifyListeners();
  }

  void newChat() {
    stop();
    conversationId = null;
    title = null;
    messages = [];
    error = '';
    _hadHistory = false;
    notifyListeners();
  }

  Future<void> openConversation(String id, {String? withTitle}) async {
    stop();
    conversationId = id;
    title = withTitle;
    messages = [];
    error = '';
    loadingMessages = true;
    _hadHistory = true;
    notifyListeners();
    try {
      final res = await api.get('/api/conversations/$id/messages');
      final msgs = <ChatMessage>[];
      if (res is Map && res['messages'] is List) {
        for (final m in res['messages'] as List) {
          if (m is Map && m['role'] is String) {
            msgs.add(ChatMessage(m['role'] as String, (m['content'] ?? '') as String));
          }
        }
      }
      messages = msgs;
      final conv = (res is Map ? res['conversation'] : null);
      if (conv is Map && conv['title'] is String) title = conv['title'] as String;
    } on ApiException catch (err) {
      error = err.message;
    } finally {
      loadingMessages = false;
      notifyListeners();
    }
  }

  String _randomUuid() {
    // UUID v4 (mismo rol que crypto.randomUUID() en la web)
    final r = List<int>.generate(16, (_) => _secureRandom.nextInt(256));
    r[6] = (r[6] & 0x0F) | 0x40;
    r[8] = (r[8] & 0x3F) | 0x80;
    String hex(int start, int end) => r
        .sublist(start, end)
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
  }

  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (streaming || trimmed.isEmpty) return;
    if (model.isEmpty) {
      error = 'No hay modelos disponibles ahora mismo. Reintenta en un momento.';
      notifyListeners();
      return;
    }

    final convId = conversationId ?? _randomUuid();
    final isFirstExchange = messages.isEmpty && !_hadHistory;
    final history = [
      ...messages.map((m) => {'role': m.role, 'content': m.content}),
      {'role': 'user', 'content': trimmed},
    ];

    conversationId = convId;
    messages = [...messages, ChatMessage('user', trimmed), ChatMessage('assistant', '')];
    streaming = true;
    error = '';
    draft = '';
    notifyListeners();

    _handle = streamChatCompletion(
      base: api.base,
      token: auth.apiKey,
      model: model,
      messages: history,
      conversationId: convId,
      webSearch: webSearch,
      onDelta: (delta) {
        messages.last.content += delta;
        notifyListeners();
      },
      onSources: (sources) {
        messages.last.sources = sources;
        notifyListeners();
      },
      onDone: () {
        streaming = false;
        _handle = null;
        notifyListeners();
        if (isFirstExchange) _generateTitle(convId);
      },
      onError: (err) {
        // Si no llegó nada, se retira la burbuja vacía del asistente
        if (messages.isNotEmpty &&
            messages.last.role == 'assistant' &&
            messages.last.content.isEmpty) {
          messages = messages.sublist(0, messages.length - 1);
        }
        streaming = false;
        _handle = null;
        error = err is ApiException ? err.message : 'Se perdió la conexión con el servidor';
        notifyListeners();
      },
    );
  }

  void stop() {
    _handle?.cancel();
    _handle = null;
    if (streaming) {
      streaming = false;
      notifyListeners();
    }
  }

  Future<void> _generateTitle(String convId) async {
    try {
      final res = await api.post('/api/conversations/$convId/generate-title');
      if (conversationId == convId && res is Map && res['title'] is String) {
        title = res['title'] as String;
        notifyListeners();
      }
    } catch (_) {
      // sin título automático: no es crítico
    }
  }
}

final Random _secureRandom = Random.secure();
