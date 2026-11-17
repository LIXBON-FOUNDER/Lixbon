#!/bin/sh
# La clave llega por entorno al crear el contenedor (la genera el gateway).
set -eu
if [ -z "${INGRESS_SECRET:-}" ] || [ ${#INGRESS_SECRET} -lt 24 ]; then
  echo "INGRESS_SECRET falta o es corta" >&2
  exit 1
fi
CONF=/tmp/tinyproxy.conf
cat > "$CONF" <<EOF
Port 8899
Listen 0.0.0.0
Timeout 600
LogLevel Notice
MaxClients 100
DisableViaHeader Yes
BasicAuth lixbon ${INGRESS_SECRET}
FilterDefaultDeny Yes
FilterURLs On
FilterType ere
Filter "/tmp/allow.txt"
ConnectPort 7000
EOF
printf '%s\n' '^http://lixbon-sbx-[0-9a-f]{12}:7000/' '^lixbon-sbx-[0-9a-f]{12}:7000$' > /tmp/allow.txt
exec tinyproxy -d -c "$CONF"
