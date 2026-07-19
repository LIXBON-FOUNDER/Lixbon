// chat_screen.dart — conversación con streaming SSE, markdown en respuestas
// y selector de modelo. Burbujas: usuario invertido (primary), asistente
// plano, como en el chat de la web.
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late final TextEditingController input;

  @override
  void initState() {
    super.initState();
    final chat = context.read<ChatState>();
    input = TextEditingController(text: chat.draft);
    if (chat.models.isEmpty) chat.loadModels();
  }

  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  void _send() {
    final chat = context.read<ChatState>();
    final text = input.text.trim();
    if (text.isEmpty || chat.streaming) return;
    input.clear();
    chat.send(text);
  }

  Future<void> _pickModel() async {
    final chat = context.read<ChatState>();
    final c = LixColors.of(context);
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: c.bg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(kRadiusBox)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Modelo',
                style: TextStyle(
                  color: c.inkSoft,
                  fontFamily: kFontUi,
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                ),
              ),
              const SizedBox(height: 8),
              if (chat.models.isEmpty)
                Text(
                  'No hay modelos disponibles.',
                  style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 13),
                ),
              ...chat.models.map((m) => ListTile(
                    dense: true,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    tileColor: m == chat.model ? c.accentSoft : null,
                    title: Text(
                      m,
                      style: TextStyle(
                        color: c.ink,
                        fontFamily: kFontUi,
                        fontWeight: m == chat.model ? FontWeight.w500 : FontWeight.w400,
                        fontSize: 14,
                      ),
                    ),
                    trailing: m == chat.model
                        ? Icon(Icons.check, size: 16, color: c.accentDeep)
                        : null,
                    onTap: () {
                      chat.setModel(m);
                      Navigator.of(ctx).pop();
                    },
                  )),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    final chat = context.watch<ChatState>();
    final auth = context.watch<AuthState>();
    final firstName = auth.user?['first_name'];

    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: Column(
          children: [
            // Cabecera: título + modelo + nueva conversación
            Container(
              padding: const EdgeInsets.fromLTRB(16, 8, 12, 10),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: c.borderSoft)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          chat.title ?? 'Nueva conversación',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: c.ink,
                            fontFamily: kFontUi,
                            fontWeight: FontWeight.w600,
                            fontSize: 16,
                          ),
                        ),
                        InkWell(
                          onTap: _pickModel,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Flexible(
                                child: Text(
                                  chat.model.isEmpty ? 'Sin modelos' : chat.model,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: c.inkSoft,
                                    fontFamily: kFontUi,
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                              Icon(Icons.keyboard_arrow_down, size: 14, color: c.inkSoft),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: chat.newChat,
                    style: IconButton.styleFrom(backgroundColor: c.bgSecondary),
                    icon: Icon(Icons.edit_outlined, size: 20, color: c.ink),
                    tooltip: 'Nueva conversación',
                  ),
                ],
              ),
            ),

            Expanded(
              child: chat.loadingMessages
                  ? Center(child: CircularProgressIndicator(color: c.inkSoft))
                  : chat.messages.isEmpty
                      ? _EmptyState(firstName: firstName is String ? firstName : null)
                      : _MessageList(chat: chat),
            ),

            if (chat.error.isNotEmpty)
              Container(
                margin: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: c.dangerSoft,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        chat.error,
                        style: TextStyle(color: c.danger, fontFamily: kFontUi, fontSize: 13),
                      ),
                    ),
                    InkWell(
                      onTap: chat.clearError,
                      child: Icon(Icons.close, size: 16, color: c.danger),
                    ),
                  ],
                ),
              ),

            // Barra de composición
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
              child: Container(
                padding: const EdgeInsets.all(6),
                decoration: BoxDecoration(
                  color: c.bgInput,
                  borderRadius: BorderRadius.circular(26),
                  border: Border.all(color: c.borderSoft),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    // Modo investigar (búsqueda web)
                    InkWell(
                      borderRadius: BorderRadius.circular(18),
                      onTap: () => chat.setWebSearch(!chat.webSearch),
                      child: Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          color: chat.webSearch ? c.accentSoft : Colors.transparent,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          Icons.public,
                          size: 19,
                          color: chat.webSearch ? c.accentDeep : c.inkMuted,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: TextField(
                        controller: input,
                        onChanged: chat.setDraft,
                        minLines: 1,
                        maxLines: 5,
                        textInputAction: TextInputAction.newline,
                        style: TextStyle(color: c.ink, fontFamily: kFontUi, fontSize: 15),
                        decoration: InputDecoration(
                          hintText: 'Escribe un mensaje…',
                          hintStyle: TextStyle(color: c.inkMuted, fontFamily: kFontUi),
                          border: InputBorder.none,
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(vertical: 9),
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    InkWell(
                      borderRadius: BorderRadius.circular(18),
                      onTap: chat.streaming ? chat.stop : _send,
                      child: Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(color: c.primary, shape: BoxShape.circle),
                        child: Icon(
                          chat.streaming ? Icons.stop : Icons.arrow_upward,
                          size: 18,
                          color: c.onPrimary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final String? firstName;
  const _EmptyState({this.firstName});

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Spark(size: 26, color: c.accentDeep),
          const SizedBox(height: 14),
          const LixLogo(size: 24),
          const SizedBox(height: 14),
          Text(
            '${firstName != null ? 'Hola, $firstName. ' : ''}¿En qué te ayudo hoy?',
            textAlign: TextAlign.center,
            style: TextStyle(color: c.inkSoft, fontFamily: kFontUi, fontSize: 15),
          ),
        ],
      ),
    );
  }
}

class _MessageList extends StatelessWidget {
  final ChatState chat;
  const _MessageList({required this.chat});

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    // Lista invertida: el índice 0 es el último mensaje → auto-scroll natural.
    final items = chat.messages.reversed.toList();
    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      itemCount: items.length,
      itemBuilder: (context, index) {
        final msg = items[index];
        final isLast = index == 0;
        if (msg.role == 'user') {
          return Align(
            alignment: Alignment.centerRight,
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 6),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.85,
              ),
              decoration: BoxDecoration(
                color: c.primary,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(18),
                  topRight: Radius.circular(18),
                  bottomLeft: Radius.circular(18),
                  bottomRight: Radius.circular(6),
                ),
              ),
              child: Text(
                msg.content,
                style: TextStyle(
                  color: c.onPrimary,
                  fontFamily: kFontUi,
                  fontSize: 15,
                  height: 1.4,
                ),
              ),
            ),
          );
        }
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (msg.sources != null && msg.sources!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: msg.sources!.take(4).map((s) {
                      final title = (s is Map ? (s['title'] ?? s['url']) : null)?.toString() ?? '';
                      final url = (s is Map ? s['url'] : null)?.toString();
                      return InkWell(
                        onTap: url != null
                            ? () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication)
                            : null,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                          decoration: BoxDecoration(
                            color: c.bgSecondary,
                            borderRadius: BorderRadius.circular(kRadiusPill),
                            border: Border.all(color: c.borderSoft),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.public, size: 12, color: c.inkSoft),
                              const SizedBox(width: 5),
                              ConstrainedBox(
                                constraints: const BoxConstraints(maxWidth: 140),
                                child: Text(
                                  title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: c.inkSoft,
                                    fontFamily: kFontUi,
                                    fontSize: 11,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    }).toList(),
                  ),
                ),
              if (msg.content.isNotEmpty)
                MarkdownBody(
                  data: msg.content,
                  onTapLink: (text, href, _) {
                    if (href != null) {
                      launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication);
                    }
                  },
                  styleSheet: _markdownStyle(c),
                )
              else if (isLast && chat.streaming)
                Row(
                  children: [
                    SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2, color: c.inkSoft),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      'Pensando…',
                      style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 13),
                    ),
                  ],
                ),
            ],
          ),
        );
      },
    );
  }
}

MarkdownStyleSheet _markdownStyle(LixColors c) {
  const mono = TextStyle(fontFamily: 'monospace', fontSize: 13);
  return MarkdownStyleSheet(
    p: TextStyle(color: c.ink, fontFamily: kFontUi, fontSize: 15, height: 1.45),
    h1: TextStyle(color: c.ink, fontFamily: kFontUi, fontWeight: FontWeight.w600, fontSize: 20),
    h2: TextStyle(color: c.ink, fontFamily: kFontUi, fontWeight: FontWeight.w600, fontSize: 18),
    h3: TextStyle(color: c.ink, fontFamily: kFontUi, fontWeight: FontWeight.w600, fontSize: 16),
    strong: TextStyle(color: c.ink, fontFamily: kFontUi, fontWeight: FontWeight.w700),
    em: TextStyle(color: c.ink, fontFamily: kFontUi, fontStyle: FontStyle.italic),
    a: TextStyle(color: c.accentDeep, decoration: TextDecoration.underline),
    listBullet: TextStyle(color: c.inkSoft, fontFamily: kFontUi, fontSize: 15),
    blockquote: TextStyle(color: c.inkSoft, fontFamily: kFontUi, fontSize: 14),
    blockquoteDecoration: BoxDecoration(
      color: c.bgSecondary,
      borderRadius: BorderRadius.circular(6),
      border: Border(left: BorderSide(color: c.accentDeep, width: 3)),
    ),
    // Un único estilo `code` cubre inline y bloques: fondo bgSecondary en
    // ambos para que el texto tinta sea legible en los dos temas.
    code: mono.copyWith(color: c.ink, backgroundColor: c.bgSecondary),
    codeblockDecoration: BoxDecoration(
      color: c.bgSecondary,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: c.borderSoft),
    ),
    codeblockPadding: const EdgeInsets.all(12),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: c.borderSoft)),
    ),
    tableBorder: TableBorder.all(color: c.borderSoft),
    tableBody: TextStyle(color: c.ink, fontFamily: kFontUi, fontSize: 13),
  );
}
