// history_screen.dart — historial de conversaciones (compartido con la web:
// source=web). Buscar, abrir, renombrar y borrar con mantener pulsado.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';

class HistoryScreen extends StatefulWidget {
  /// Cambia a la pestaña de chat tras abrir una conversación.
  final VoidCallback onOpenChat;
  const HistoryScreen({super.key, required this.onOpenChat});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  List<Map<String, dynamic>> items = [];
  bool loading = true;
  String query = '';
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    final api = context.read<ApiClient>();
    if (!silent) setState(() => loading = true);
    try {
      final qs = query.isNotEmpty
          ? '?q=${Uri.encodeComponent(query)}&source=web'
          : '?source=web';
      final res = await api.get('/api/conversations$qs');
      if (!mounted) return;
      final list = <Map<String, dynamic>>[];
      if (res is Map && res['conversations'] is List) {
        for (final c in res['conversations'] as List) {
          if (c is Map) list.add(Map<String, dynamic>.from(c));
        }
      }
      setState(() => items = list);
    } catch (_) {
      // offline: se queda la lista anterior
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  void _onQuery(String value) {
    query = value;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => _load(silent: true));
  }

  String _formatWhen(dynamic iso) {
    if (iso is! String || iso.isEmpty) return '';
    final d = DateTime.tryParse(iso);
    if (d == null) return '';
    final local = d.toLocal();
    final days = DateTime.now().difference(local).inDays;
    if (days <= 0) {
      final h = local.hour.toString().padLeft(2, '0');
      final m = local.minute.toString().padLeft(2, '0');
      return '$h:$m';
    }
    if (days == 1) return 'ayer';
    if (days < 7) return 'hace $days días';
    return '${local.day.toString().padLeft(2, '0')}/${local.month.toString().padLeft(2, '0')}/${local.year}';
  }

  Future<void> _open(Map<String, dynamic> item) async {
    final chat = context.read<ChatState>();
    final title = item['title'];
    unawaited(chat.openConversation(
      item['id'] as String,
      withTitle: title is String ? title : null,
    ));
    widget.onOpenChat();
  }

  Future<void> _rename(Map<String, dynamic> item) async {
    final api = context.read<ApiClient>();
    final current = (item['title'] as String?) ?? '';
    final value = await showPromptDialog(
      context,
      title: 'Renombrar conversación',
      placeholder: 'Nuevo título',
      initialValue: current,
      confirmLabel: 'Guardar',
    );
    final trimmed = value?.trim() ?? '';
    if (trimmed.isEmpty) return;
    try {
      await api.patch('/api/conversations/${item['id']}', body: {'title': trimmed});
      if (!mounted) return;
      setState(() {
        items = items
            .map((c) => c['id'] == item['id'] ? {...c, 'title': trimmed} : c)
            .toList();
      });
    } on ApiException catch (err) {
      _showError(err.message);
    }
  }

  Future<void> _delete(Map<String, dynamic> item) async {
    final api = context.read<ApiClient>();
    final chat = context.read<ChatState>();
    final ok = await showConfirmDialog(
      context,
      title: 'Eliminar conversación',
      message: '"${item['title'] ?? 'Sin título'}" se eliminará definitivamente.',
      confirmLabel: 'Eliminar',
      danger: true,
    );
    if (!ok) return;
    try {
      await api.delete('/api/conversations/${item['id']}');
      if (!mounted) return;
      setState(() => items = items.where((c) => c['id'] != item['id']).toList());
      if (chat.conversationId == item['id']) chat.newChat();
    } on ApiException catch (err) {
      _showError(err.message);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _longPress(Map<String, dynamic> item) async {
    final c = LixColors.of(context);
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: c.bg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(kRadiusBox)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.drive_file_rename_outline, color: c.ink),
              title: Text('Renombrar',
                  style: TextStyle(color: c.ink, fontFamily: kFontUi)),
              onTap: () => Navigator.of(ctx).pop('rename'),
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: c.danger),
              title: Text('Eliminar',
                  style: TextStyle(color: c.danger, fontFamily: kFontUi)),
              onTap: () => Navigator.of(ctx).pop('delete'),
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (action == 'rename') await _rename(item);
    if (action == 'delete') await _delete(item);
  }

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
              child: Text(
                'Historial',
                style: TextStyle(
                  color: c.ink,
                  fontFamily: kFontUi,
                  fontWeight: FontWeight.w600,
                  fontSize: 22,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
              child: TextField(
                onChanged: _onQuery,
                style: TextStyle(color: c.ink, fontFamily: kFontUi, fontSize: 14),
                decoration: InputDecoration(
                  hintText: 'Buscar conversaciones…',
                  hintStyle: TextStyle(color: c.inkMuted, fontFamily: kFontUi),
                  prefixIcon: Icon(Icons.search, size: 18, color: c.inkMuted),
                  filled: true,
                  fillColor: c.bgInput,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(kRadiusPill),
                    borderSide: BorderSide(color: c.borderSoft),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(kRadiusPill),
                    borderSide: BorderSide(color: c.border),
                  ),
                ),
              ),
            ),
            Expanded(
              child: loading && items.isEmpty
                  ? Center(child: CircularProgressIndicator(color: c.inkSoft))
                  : items.isEmpty
                      ? _empty(c)
                      : RefreshIndicator(
                          color: c.ink,
                          onRefresh: () => _load(silent: true),
                          child: ListView.separated(
                            padding: const EdgeInsets.fromLTRB(14, 0, 14, 20),
                            itemCount: items.length,
                            separatorBuilder: (_, __) =>
                                Divider(height: 1, color: c.borderSoft),
                            itemBuilder: (context, index) {
                              final item = items[index];
                              return InkWell(
                                onTap: () => _open(item),
                                onLongPress: () => _longPress(item),
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                      vertical: 13, horizontal: 8),
                                  child: Row(
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              (item['title'] as String?) ??
                                                  'Sin título',
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: TextStyle(
                                                color: c.ink,
                                                fontFamily: kFontUi,
                                                fontWeight: FontWeight.w500,
                                                fontSize: 15,
                                              ),
                                            ),
                                            const SizedBox(height: 2),
                                            Text(
                                              _formatWhen(item['updated_at'] ??
                                                  item['created_at']),
                                              style: TextStyle(
                                                color: c.inkMuted,
                                                fontFamily: kFontUi,
                                                fontSize: 12,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                      Icon(Icons.chevron_right,
                                          size: 18, color: c.inkMuted),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _empty(LixColors c) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.forum_outlined, size: 34, color: c.inkMuted),
          const SizedBox(height: 12),
          Text(
            query.isNotEmpty
                ? 'Sin resultados para tu búsqueda.'
                : 'Aún no tienes conversaciones.\nEmpieza una desde el chat.',
            textAlign: TextAlign.center,
            style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 14),
          ),
        ],
      ),
    );
  }
}
