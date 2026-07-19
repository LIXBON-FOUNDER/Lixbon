// sse.dart — streaming del chat (POST /v1/chat/completions con stream:true).
// Mismo protocolo que la web (lib/stream.js): chunks formato OpenAI,
// comentarios keep-alive y cierre con "data: [DONE]".
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api.dart';

class ChatStreamHandle {
  final http.Client _client;
  bool cancelled = false;

  ChatStreamHandle(this._client);

  void cancel() {
    cancelled = true;
    _client.close();
  }
}

ChatStreamHandle streamChatCompletion({
  required String base,
  required String? token,
  required String model,
  required List<Map<String, dynamic>> messages,
  required String conversationId,
  required bool webSearch,
  required void Function(String delta) onDelta,
  required void Function(List<dynamic> sources) onSources,
  required void Function() onDone,
  required void Function(Object error) onError,
}) {
  final client = http.Client();
  final handle = ChatStreamHandle(client);

  Future<void> run() async {
    try {
      final req = http.Request('POST', Uri.parse('$base/v1/chat/completions'));
      req.headers['Content-Type'] = 'application/json';
      req.headers['Accept'] = 'text/event-stream';
      if (token != null) req.headers['Authorization'] = 'Bearer $token';
      req.body = jsonEncode({
        'model': model,
        'messages': messages,
        'conversation_id': conversationId,
        'stream': true,
        'web_search': webSearch,
        // Historial compartido con la web: misma cuenta, mismas conversaciones.
        'source': 'web',
      });

      final res = await client.send(req);
      if (res.statusCode >= 400) {
        final body = await res.stream.bytesToString();
        dynamic data;
        try {
          data = jsonDecode(body);
        } catch (_) {
          data = null;
        }
        throw ApiException(extractDetail(data, res.statusCode), status: res.statusCode);
      }

      var buffer = '';
      var done = false;
      await for (final chunk in res.stream.transform(utf8.decoder)) {
        if (handle.cancelled) return;
        buffer += chunk;
        final events = buffer.split('\n\n');
        buffer = events.removeLast(); // el último puede venir incompleto
        for (final event in events) {
          final line = event.trim();
          if (!line.startsWith('data:')) continue; // ignora keep-alives
          final data = line.substring(5).trim();
          if (data == '[DONE]') {
            done = true;
            break;
          }
          try {
            final obj = jsonDecode(data);
            if (obj is Map && obj['lixbon_sources'] is List) {
              onSources(obj['lixbon_sources'] as List);
              continue;
            }
            if (obj is Map) {
              final choices = obj['choices'];
              if (choices is List && choices.isNotEmpty) {
                final delta = choices[0]?['delta']?['content'];
                if (delta is String && delta.isNotEmpty) onDelta(delta);
              }
            }
          } catch (_) {
            // chunk malformado: se ignora
          }
        }
        if (done) break;
      }
      if (!handle.cancelled) onDone();
    } catch (err) {
      if (!handle.cancelled) onError(err);
    } finally {
      client.close();
    }
  }

  run();
  return handle;
}
