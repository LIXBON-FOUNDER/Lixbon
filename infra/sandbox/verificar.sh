#!/bin/sh
# Pruebas de aislamiento DENTRO de un entorno de Coding (las corre
# infra/sandbox/verificar.ps1 con docker exec). Cada línea: OK o FALLO.
ok() { echo "OK    $1"; }
mal() { echo "FALLO $1"; FALLOS=1; }
FALLOS=0
REPO_DIR="/workspace/$(basename "$LIXBON_REPO")"

[ "$(id -u)" != "0" ] && ok "no es root (uid $(id -u))" || mal "corre como root"
CAP=$(grep CapEff /proc/self/status | awk '{print $2}')
[ "$CAP" = "0000000000000000" ] && ok "sin capacidades" || mal "capacidades efectivas $CAP"
grep -q 'NoNewPrivs:[[:space:]]*1' /proc/self/status && ok "no-new-privileges" || mal "sin no-new-privileges"
touch /usr/local/bin/x 2>/dev/null && mal "el sistema de archivos se puede escribir" || ok "rootfs de solo lectura"
[ -S /var/run/docker.sock ] && mal "socket de docker montado" || ok "sin socket de docker"

curl -s -m 6 -o /dev/null https://example.com && mal "salida a example.com" || ok "example.com bloqueado"
curl -s -m 6 -o /dev/null --noproxy '*' https://github.com && mal "salida directa sin proxy" || ok "sin salida directa (solo por el proxy)"
curl -s -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/react | grep -q 200 && ok "npm permitido" || mal "npm no responde"
c=$(curl -s -m 6 -o /dev/null -w '%{http_code}' http://host.docker.internal:11434/)
[ "$c" = "403" ] || [ "$c" = "000" ] && ok "otros puertos del anfitrión bloqueados ($c)" || mal "otro puerto del anfitrión accesible ($c)"
c=$(curl -s -m 6 -o /dev/null -w '%{http_code}' -x http://lixbon-ingress:8899 "http://lixbon-sbx-$LIXBON_SESSION_ID:7000/")
[ "$c" = "407" ] && ok "el proxy de entrada exige clave ($c)" || mal "proxy de entrada sin clave ($c)"

env | grep -qiE 'gh[pousr]_[A-Za-z0-9]|github_token|lixbon_sk_' && mal "token de GitHub o API key en el entorno" || ok "sin tokens de GitHub ni API keys en el entorno"
grep -rqiE 'gh[pousr]_|x-access-token' "$REPO_DIR/.git/config" 2>/dev/null && mal "token en .git/config" || ok "sin tokens en .git/config"

cd "$REPO_DIR" 2>/dev/null && {
  # Un commit de verdad: sin él, git no manda nada («Everything up-to-date»).
  git commit -q --allow-empty -m "prueba de aislamiento (se deshace)" && {
    git push -q origin HEAD:refs/heads/main 2>/tmp/push.err && mal "push a main aceptado" || ok "push a main rechazado ($(head -c 100 /tmp/push.err | tr '\n' ' '))"
    git push -q origin HEAD:refs/tags/v-prueba 2>/dev/null && mal "push de tag aceptado" || ok "push de tags rechazado"
    git reset -q --hard HEAD~1
  }
}
H="Authorization: Bearer $LIXBON_SESSION_TOKEN"
for ruta in /api/conversations /api/remote/sessions /api/connectors/github/repos /api/coding/estado; do
  c=$(curl -s -m 6 -o /dev/null -w '%{http_code}' -H "$H" "$LIXBON_GATEWAY$ruta")
  [ "$c" = "401" ] || [ "$c" = "403" ] && ok "token fuera de alcance en $ruta ($c)" || mal "token acepta $ruta ($c)"
done
c=$(curl -s -m 6 -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"approve","id":"x","decision":"allow"}' "$LIXBON_GATEWAY/api/remote/sessions/$LIXBON_SESSION_ID/commands")
[ "$c" = "401" ] && ok "el agente no puede aprobarse a sí mismo ($c)" || mal "POST /commands con el token ($c)"
exit $FALLOS
