# Proxy de SALIDA de los entornos de Coding. Los entornos viven en redes
# `internal` (sin salida); este contenedor es lo único que comparten con el
# exterior y solo deja pasar la lista de allowlist.txt.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy \
 && adduser -D -H -u 10001 proxy-lx
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allowlist.txt /etc/tinyproxy/allowlist.txt
USER 10001
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
