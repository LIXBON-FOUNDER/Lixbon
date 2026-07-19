// oauth.dart — lado cliente del login con Google/Apple.
// El navegador (Custom Tab) hace el flujo contra el gateway, que guarda los
// secretos de proveedor; la app solo genera el PKCE y canjea el código:
// un código interceptado en la redirección no sirve sin el code_verifier.
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

import 'api.dart';

String _b64url(List<int> bytes) =>
    base64UrlEncode(bytes).replaceAll('=', '');

class OAuthResult {
  final String code;
  final String verifier;
  OAuthResult(this.code, this.verifier);
}

Future<OAuthResult> oauthAuthorize(String provider, String base) async {
  final rnd = Random.secure();
  final verifier = _b64url(List<int>.generate(32, (_) => rnd.nextInt(256)));
  final challenge = _b64url(sha256.convert(utf8.encode(verifier)).bytes);

  // El gateway solo acepta lixbon://, exp:// y la propia web (allowlist
  // anti open-redirect); la app instalada usa siempre lixbon://oauth.
  const redirectUri = 'lixbon://oauth';
  final startUrl = '$base/api/auth/oauth/$provider/start'
      '?redirect_uri=${Uri.encodeComponent(redirectUri)}'
      '&code_challenge=${Uri.encodeComponent(challenge)}';

  final String result;
  try {
    result = await FlutterWebAuth2.authenticate(
      url: startUrl,
      callbackUrlScheme: 'lixbon',
    );
  } catch (_) {
    throw ApiException('Inicio de sesión cancelado');
  }

  final uri = Uri.parse(result);
  if (uri.queryParameters['lixbon_error'] != null) {
    throw ApiException('Inicio de sesión cancelado');
  }
  final code = uri.queryParameters['lixbon_code'];
  if (code == null || code.isEmpty) {
    throw ApiException('No se recibió el código de acceso');
  }
  return OAuthResult(code, verifier);
}
