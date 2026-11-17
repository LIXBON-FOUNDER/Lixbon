# Proxy de ENTRADA para la vista previa: el gateway (en el anfitrión) llega por
# aquí al puerto 7000 de cada entorno. Se conecta a la red de cada sesión, así
# que exige una clave (Basic) que solo conoce el gateway: un entorno no puede
# usarlo para alcanzar a otro.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy \
 && adduser -D -H -u 10001 proxy-lx
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod 0555 /entrypoint.sh
USER 10001
EXPOSE 8899
ENTRYPOINT ["/entrypoint.sh"]
