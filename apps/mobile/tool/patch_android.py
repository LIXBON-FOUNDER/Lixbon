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
  5. compileSdk 36 + AGP 8.9.1 + NDK 27: androidx.browser 1.9 (dependencia de
     flutter_web_auth_2 5.x) los exige y la plantilla de Flutter 3.32 trae
     compileSdk 35 / AGP 8.7.3 — visto fallar en el primer run del CI.
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


def patch_app_gradle() -> None:
    # La plantilla puede ser Groovy (build.gradle) o Kotlin DSL (build.gradle.kts).
    for name in ("build.gradle.kts", "build.gradle"):
        gradle = ROOT / "android" / "app" / name
        if not gradle.exists():
            continue
        text = gradle.read_text(encoding="utf-8")
        kts = name.endswith(".kts")

        def sdk_repl(prop: str, value: str):
            def repl(m: re.Match) -> str:
                if "=" in m.group(0) or kts:
                    return f"{prop} = {value}"
                return f"{prop} {value}"
            return repl

        new = re.sub(
            r"minSdk(?:Version)?\s*=?\s*flutter\.minSdkVersion",
            sdk_repl("minSdk", "23"), text)
        new = re.sub(
            r"compileSdk(?:Version)?\s*=?\s*flutter\.compileSdkVersion",
            sdk_repl("compileSdk", "36"), new)
        new = re.sub(
            r"ndkVersion\s*=?\s*flutter\.ndkVersion",
            sdk_repl("ndkVersion", '"27.0.12077973"'), new)

        if new != text:
            gradle.write_text(new, encoding="utf-8")
            print(f"patch_android: minSdk=23, compileSdk=36, ndk=27 en {name}")
        return
    fail("no se encontró android/app/build.gradle(.kts)")


def patch_agp_version() -> None:
    """androidx.browser 1.9 exige AGP >= 8.9.1; la plantilla trae 8.7.x."""
    for name in ("settings.gradle.kts", "settings.gradle"):
        settings = ROOT / "android" / name
        if not settings.exists():
            continue
        text = settings.read_text(encoding="utf-8")
        new = re.sub(
            r'(com\.android\.application"\)?\s+version\s+")(\d+(?:\.\d+)+)(")',
            lambda m: m.group(1) + ("8.9.1" if _ver(m.group(2)) < (8, 9, 1) else m.group(2)) + m.group(3),
            text,
        )
        if new != text:
            settings.write_text(new, encoding="utf-8")
            print(f"patch_android: AGP 8.9.1 en {name}")
        return
    fail("no se encontró android/settings.gradle(.kts)")


def _ver(s: str) -> tuple:
    return tuple(int(p) for p in s.split("."))


def patch_gradle_wrapper() -> None:
    """AGP 8.9 necesita Gradle >= 8.11.1; se sube el wrapper si es más viejo."""
    props = ROOT / "android" / "gradle" / "wrapper" / "gradle-wrapper.properties"
    if not props.exists():
        return  # sin wrapper no hay nada que subir (flutter usa el suyo)
    text = props.read_text(encoding="utf-8")
    m = re.search(r"gradle-(\d+(?:\.\d+)+)-", text)
    if m and _ver(m.group(1)) < (8, 11, 1):
        new = text.replace(f"gradle-{m.group(1)}-", "gradle-8.12-")
        props.write_text(new, encoding="utf-8")
        print(f"patch_android: Gradle {m.group(1)} -> 8.12 en el wrapper")


def remove_template_test() -> None:
    # flutter create genera test/widget_test.dart apuntando a un MyApp que no
    # existe; rompería `flutter analyze`.
    t = ROOT / "test" / "widget_test.dart"
    if t.exists():
        t.unlink()
        print("patch_android: test de plantilla eliminado")


if __name__ == "__main__":
    patch_manifest()
    patch_app_gradle()
    patch_agp_version()
    patch_gradle_wrapper()
    remove_template_test()
    print("patch_android: listo")
