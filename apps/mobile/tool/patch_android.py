#!/usr/bin/env python3
"""
patch_android.py — Ajustes sobre el proyecto Android que genera
`flutter create --platforms=android .` en el CI (la carpeta android/ no se
versiona; este script la deja lista de forma determinista):

  1. Permiso INTERNET en el manifest de release (la plantilla solo lo pone
     en debug/profile: sin esto la app compilada no tiene red).
  2. Activity de callback de flutter_web_auth_2 para el deep link lixbon://
     (retorno del OAuth de Google/Apple).
  3. minSdk 23 (lo exige flutter_secure_storage/Keystore).
  4. Etiqueta visible "Lixbon" (la plantilla pone el nombre del paquete).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "android" / "app" / "src" / "main" / "AndroidManifest.xml"

CALLBACK_ACTIVITY = """\
        <activity
            android:name="com.linusu.flutter_web_auth_2.CallbackActivity"
            android:exported="true">
            <intent-filter android:label="flutter_web_auth_2">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="lixbon" />
            </intent-filter>
        </activity>
"""


def fail(msg: str) -> None:
    print(f"patch_android: {msg}", file=sys.stderr)
    sys.exit(1)


def patch_manifest() -> None:
    if not MANIFEST.exists():
        fail(f"no existe {MANIFEST} — ¿se ejecutó `flutter create --platforms=android .`?")
    text = MANIFEST.read_text(encoding="utf-8")

    if "android.permission.INTERNET" not in text:
        text = text.replace(
            "<application",
            '<uses-permission android:name="android.permission.INTERNET" />\n    <application',
            1,
        )

    if "flutter_web_auth_2.CallbackActivity" not in text:
        # Antes del cierre de <application>, tras las activities existentes.
        if "</application>" not in text:
            fail("manifest sin </application>")
        text = text.replace("</application>", CALLBACK_ACTIVITY + "    </application>", 1)

    text = text.replace('android:label="lixbon"', 'android:label="Lixbon"')
    MANIFEST.write_text(text, encoding="utf-8")
    print("patch_android: manifest OK")


def patch_min_sdk() -> None:
    # La plantilla puede ser Groovy (build.gradle) o Kotlin DSL (build.gradle.kts).
    for name in ("build.gradle.kts", "build.gradle"):
        gradle = ROOT / "android" / "app" / name
        if not gradle.exists():
            continue
        text = gradle.read_text(encoding="utf-8")
        new = re.sub(
            r"minSdk(?:Version)?\s*=?\s*flutter\.minSdkVersion",
            lambda m: ("minSdk = 23" if "=" in m.group(0) or name.endswith(".kts")
                       else "minSdkVersion 23"),
            text,
        )
        if new != text:
            gradle.write_text(new, encoding="utf-8")
            print(f"patch_android: minSdk=23 en {name}")
        return
    fail("no se encontró android/app/build.gradle(.kts)")


def remove_template_test() -> None:
    # flutter create genera test/widget_test.dart apuntando a un MyApp que no
    # existe; rompería `flutter analyze`.
    t = ROOT / "test" / "widget_test.dart"
    if t.exists():
        t.unlink()
        print("patch_android: test de plantilla eliminado")


if __name__ == "__main__":
    patch_manifest()
    patch_min_sdk()
    remove_template_test()
    print("patch_android: listo")
