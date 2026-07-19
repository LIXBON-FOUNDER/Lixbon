// api.dart — cliente HTTP del gateway. Mismo criterio que la web (lib/api.js):
// errores normalizados desde `detail` (string u objeto {code, message}) y
// logout automático en 401. Auth por Bearer API key.
import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  final String message;
  final int? status;
  ApiException(this.message, {this.status});

  @override
  String toString() => message;
}

class ApiClient {
  final String Function() baseUrl;
  final String? Function() token;
  void Function()? onUnauthorized;

  ApiClient({required this.baseUrl, required this.token, this.onUnauthorized});

  String get base => baseUrl().replaceAll(RegExp(r'/+$'), '');

  Future<dynamic> request(
    String path, {
    String method = 'GET',
    Object? body,
    bool auth = true,
  }) async {
    final uri = Uri.parse('$base$path');
    final headers = <String, String>{'Content-Type': 'application/json'};
    final tok = token();
    if (auth && tok != null) headers['Authorization'] = 'Bearer $tok';

    http.Response res;
    try {
      switch (method) {
        case 'POST':
          res = await http.post(uri, headers: headers, body: body != null ? jsonEncode(body) : null);
        case 'PATCH':
          res = await http.patch(uri, headers: headers, body: body != null ? jsonEncode(body) : null);
        case 'DELETE':
          res = await http.delete(uri, headers: headers, body: body != null ? jsonEncode(body) : null);
        default:
          res = await http.get(uri, headers: headers);
      }
    } catch (_) {
      throw ApiException('Sin conexión con el servidor');
    }

    dynamic data;
    try {
      data = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      data = null; // respuesta sin cuerpo JSON
    }

    if (res.statusCode >= 400) {
      if (res.statusCode == 401 && auth && tok != null) {
        onUnauthorized?.call();
      }
      throw ApiException(extractDetail(data, res.statusCode), status: res.statusCode);
    }
    return data;
  }

  Future<dynamic> get(String path, {bool auth = true}) =>
      request(path, auth: auth);
  Future<dynamic> post(String path, {Object? body, bool auth = true}) =>
      request(path, method: 'POST', body: body, auth: auth);
  Future<dynamic> patch(String path, {Object? body}) =>
      request(path, method: 'PATCH', body: body);
  Future<dynamic> delete(String path, {Object? body}) =>
      request(path, method: 'DELETE', body: body);
}

/// `detail` del gateway: string plano o, en cuotas (F5), {code, message, …}.
String extractDetail(dynamic data, int statusCode) {
  if (data is Map) {
    final detail = data['detail'];
    if (detail is String && detail.isNotEmpty) return detail;
    if (detail is Map && detail['message'] is String) return detail['message'] as String;
  }
  return 'Error del servidor ($statusCode)';
}
