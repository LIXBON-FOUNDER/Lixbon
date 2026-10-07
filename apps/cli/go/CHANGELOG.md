# Historial de versiones del CLI

Cada versión lleva una sección `## <versión>` con viñetas (`- …`) escritas para quien usa el CLI. Al etiquetar `cli-v<versión>`, `release-cli.yml` las publica como notas de la release y las registra en el gateway, y la página `/apps` las muestra. Sin la sección de la versión, la release falla antes de compilar.

La etapa sale de la etiqueta: sin sufijo (`cli-v2.4.0`) es estable; con sufijo (`cli-v2.4.0-beta.1`, `cli-v2.3.0-go.2`) es beta.

## 2.3.0-go.3
- Al cambiar de proveedor con `/provider` se indica cuántos modelos ofrece y se abre el selector si el modelo guardado no está en su lista.
- Si un proveedor responde con error al listar los modelos (por ejemplo una URL sin `/v1`), el CLI muestra el código HTTP y el mensaje en lugar de «¿Está en marcha el servidor?».
- Una clave rechazada por un proveedor genérico pide la nueva al momento.
- Nuevo `lixbon profile set NOMBRE` y `/provider key NOMBRE` para cambiar la URL, la clave, el modelo o el contexto de un proveedor sin activarlo.
- `lixbon init` avisa de que modifica el proveedor activo.

## 2.3.0-go.2
- Nuevo aviso al abrir el chat cuando hay una versión más reciente: «Hay una versión nueva (vX). Ejecuta /update». Se comprueba como mucho una vez al día y se desactiva con `"update_check": false` en `config.json` o con `LIXBON_NO_UPDATE_CHECK=1`.
- `lixbon --update` actualiza el CLI, igual que `lixbon update`.
- Cada versión tiene una etapa que sale de su etiqueta: sin sufijo es estable y con sufijo (`-go.2`, `-beta.1`) es beta. `lixbon update` sigue la etapa de tu versión: quien está en estable solo recibe estables y quien está en beta recibe también las estables.
- Una instalación nueva con `install.ps1` o `install.sh` trae la última estable y, mientras no haya ninguna, la última beta.
- La página de descargas (`lixbon.com/apps`) muestra ahora la etapa de cada versión, sus novedades y el historial, y una instalación manual con enlaces a la release de GitHub, el SHA-256 de cada archivo y los comandos para verificarlo.
- La documentación y las guías ya no piden Python: el CLI es un solo ejecutable.

## 2.3.0-go.1
- Nuevo `lixbon --version` (y `lixbon version`): muestra la versión, el sistema y la arquitectura sin leer la configuración ni usar la red.
- La preferencia de la rueda del ratón (`/mouse`) se guarda en la configuración y se conserva entre sesiones.
- Los instaladores `install.sh` e `install.ps1` se prueban ahora en Linux, macOS y Windows antes de publicar.

## 2.3.0-go.0
- Primera beta del CLI en Go: un solo ejecutable, sin Python ni dependencias.
- `lixbon update` y `/update` descargan e instalan la última versión comprobando su SHA-256 contra el gateway y contra el `SHA256SUMS` de la release.
- `irm https://lixbon.com/install.ps1 | iex` y `curl -fsSL https://lixbon.com/install.sh | bash` instalan este binario.
