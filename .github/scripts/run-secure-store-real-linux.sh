#!/usr/bin/env bash
set -euo pipefail

# Aísla el test en un bus efímero. D-Bus activa el proveedor GNOME Keyring;
# --unlock crea y desbloquea un keyring local de CI sin credenciales reales.
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  exec dbus-run-session -- bash "$0" "$@"
fi

command -v gnome-keyring-daemon >/dev/null
command -v dbus-send >/dev/null

eval "$(printf '%s' 'lixbon-ci-only-keyring-password' \
  | gnome-keyring-daemon --unlock --components=secrets)"

# Exige que el daemon real posea el nombre Secret Service antes de ejecutar
# los tests; no se permite pasar por una sesión D-Bus vacía ni un backend mock.
owner_reply="$(dbus-send --session \
  --dest=org.freedesktop.DBus \
  --type=method_call \
  --print-reply \
  /org/freedesktop/DBus \
  org.freedesktop.DBus.NameHasOwner \
  string:org.freedesktop.secrets)"
if [[ "$owner_reply" != *'boolean true'* ]]; then
  printf '%s\n' 'GNOME Keyring no registró org.freedesktop.secrets en el bus de CI.' >&2
  exit 1
fi

cargo test --locked --lib \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  secure_store::os::real_tests -- --ignored --test-threads=1
