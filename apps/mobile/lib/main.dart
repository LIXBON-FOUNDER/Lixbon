// main.dart — raíz de la app móvil de Lixbon: wiring de estado (prefs,
// sesión, chat), tema claro/oscuro con los tokens de la marca y gate de
// autenticación → pestañas (Chat, Historial, Uso, Cuenta).
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'api.dart';
import 'screens/account_screen.dart';
import 'screens/auth_screen.dart';
import 'screens/chat_screen.dart';
import 'screens/history_screen.dart';
import 'screens/usage_screen.dart';
import 'state.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final prefs = PrefsState();
  await prefs.hydrate();

  late final AuthState auth;
  final api = ApiClient(
    baseUrl: () => prefs.apiBase,
    token: () => auth.apiKey,
  );
  auth = AuthState(api);
  api.onUnauthorized = auth.sessionExpired;
  final chat = ChatState(api, auth);

  await auth.hydrate();

  runApp(MultiProvider(
    providers: [
      Provider<ApiClient>.value(value: api),
      ChangeNotifierProvider<PrefsState>.value(value: prefs),
      ChangeNotifierProvider<AuthState>.value(value: auth),
      ChangeNotifierProvider<ChatState>.value(value: chat),
    ],
    child: const LixbonApp(),
  ));
}

class LixbonApp extends StatelessWidget {
  const LixbonApp({super.key});

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<PrefsState>();
    return MaterialApp(
      title: 'Lixbon',
      debugShowCheckedModeBanner: false,
      themeMode: prefs.themeMode,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const _Root(),
    );
  }
}

class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    if (!auth.ready) {
      final c = LixColors.of(context);
      return Scaffold(
        backgroundColor: c.bgSecondary,
        body: Center(child: CircularProgressIndicator(color: c.inkSoft)),
      );
    }
    return auth.apiKey != null ? const HomeShell() : const AuthScreen();
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int index = 0;

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    final screens = [
      const ChatScreen(),
      HistoryScreen(onOpenChat: () => setState(() => index = 0)),
      const UsageScreen(),
      const AccountScreen(),
    ];
    return Scaffold(
      backgroundColor: c.bg,
      body: screens[index],
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => setState(() => index = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.chat_bubble_outline),
            selectedIcon: Icon(Icons.chat_bubble),
            label: 'Chat',
          ),
          NavigationDestination(
            icon: Icon(Icons.history),
            selectedIcon: Icon(Icons.history),
            label: 'Historial',
          ),
          NavigationDestination(
            icon: Icon(Icons.bar_chart_outlined),
            selectedIcon: Icon(Icons.bar_chart),
            label: 'Uso',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Cuenta',
          ),
        ],
      ),
    );
  }
}
