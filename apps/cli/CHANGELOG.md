# Historial de versiones del CLI

Cada versión lleva una sección `## <versión>` con viñetas (`- …`) escritas para quien usa el CLI. Al etiquetar `cli-v<versión>`, `release-cli.yml` las publica como notas de la release y las registra en el gateway, y la página `/apps` las muestra. Sin la sección de la versión, la release falla antes de compilar.

La etapa sale de la etiqueta: sin sufijo (`cli-v2.4.0`) es estable; con sufijo (`cli-v2.4.0-beta.1`, `cli-v2.3.0-go.2`) es beta.

## 2.7.0
- Orquestador: `/orquestar <objetivo>` convierte al agente en coordinador de un equipo de agentes que corre en Lixbon Desktop. Cada lanzamiento y cada integración las aprueba una persona allí. `/orquestador` muestra los runs y las tareas, y explica qué falta si el orquestador no está disponible.
- Nuevo `lixbon worker`: el orquestador de Lixbon Desktop puede lanzar al CLI como un agente hijo, con cualquier proveedor de `lixbon profile`. Solo corre dentro de una tarea del orquestador y entrega su respuesta como informe.
- Nuevo `lixbon profile list --json`: lista los proveedores configurados (nunca las claves) para que Lixbon Desktop los ofrezca como modelos de un rol.

## 2.6.1
- Control remoto: desde el móvil puedes mandar fotos y documentos con el mensaje y citar archivos del proyecto; el modelo los recibe como si los adjuntaras en la terminal.
- Las ediciones del agente se ven en el móvil con su diff (archivo y líneas añadidas y borradas), también cuando te pide aprobarlas.
- Los selectores que abre el CLI se responden también desde el móvil, y desaparecen de allí en cuanto los cierras en la terminal. Desde el móvil también se puede cambiar el modelo de la sesión.
- Los avisos y los resúmenes largos de las herramientas llegan completos al móvil.

## 2.6.0
- Iniciar sesión con el navegador ya no crea una API key en tu cuenta: abre una sesión de este equipo que se renueva sola. La ves (y la puedes cerrar) en lixbon.com → Cuenta → Sesiones y dispositivos, con el nombre del equipo.
- `/logout` y `lixbon auth logout` cierran la sesión también en el servidor, no solo en este equipo.
- Varias terminales con la misma cuenta comparten la sesión sin cerrarse entre sí, y el servidor MCP de Lixbon sigue conectado aunque el chat dure horas.
- Con una API key (`lixbon setup --api-key`, `/key`) todo sigue igual. Las sesiones iniciadas con versiones anteriores siguen valiendo hasta que caduquen; después, el CLI te pide entrar otra vez.

## 2.5.0
- `/workspace` abre un navegador de carpetas: ↑↓ para moverte, → para entrar, ← para subir, Enter para usarla y escribir para filtrar. La barra superior y la tarjeta de bienvenida se actualizan con la carpeta y su rama.
- Las conversaciones son de cada carpeta o repositorio: `/history` lista solo las de aquí (`/history todas` enseña el resto) y cambiar de carpeta empieza una conversación con el contexto vacío. La cuota de la cuenta (sesión y semana) va en la barra superior.
- Nuevo `/branch` (o clic en la rama de la barra) para ver las ramas locales y remotas, cambiar de una a otra o crear una nueva.
- Nuevo `/effort` para elegir cuánto razona el modelo (auto, encendido o apagado; bajo, medio o alto en gpt-oss). Se ve en el pie.
- Los comandos de ajuste y consulta (`/model`, `/status`, `/usage`, `/tools`…) ya no llenan el chat: su resultado sale en el pie o en un panel que se cierra con Esc o al seguir escribiendo.
- El modelo puede leer páginas web también en el modo ask (`busca lixbon.com/docs`). Cada descarga se ve como `Fetch(url)` con el tamaño y el estado HTTP.
- `/compact` es mucho más rápido (el resumen se escribe sin razonar y sin reenviar páginas ni imágenes enteras) y enseña su avance. El resumen ya no aparece como un mensaje tuyo, ni en la terminal ni en la app móvil.
- Respuestas más legibles: títulos con jerarquía, bloques de código con fondo y su lenguaje, comandos destacados y tablas con bordes que se ajustan al ancho. Mientras el modelo escribe solo se ve el progreso, y una respuesta larga se muestra desde su principio, con un botón para bajar al final.
- Con el control remoto activo puedes seguir escribiendo en la terminal, y las aprobaciones se piden a la vez aquí y en el móvil. El QR queda plegado.
- Ctrl+V pega texto (o la imagen del portapapeles) en cualquier terminal. Las zonas clicables se iluminan al pasar el ratón, y los comandos en segundo plano se ven en el pie (`[2] comandos`) con su tiempo.
- `/key` solo aparece si iniciaste sesión con una API key.
- Corregido: en Windows no arrancaban los servidores MCP lanzados con `npx` cuando un argumento llevaba espacios (p. ej. `Authorization:Bearer …`).

## 2.4.0
- Nuevo diseño de la terminal con la identidad de lixbon.com: barra superior fija con proyecto, rama, plan y modelo; tarjeta de bienvenida con el prisma; zona viva con lo que está haciendo el agente, el tiempo y el paso del plan; caja de entrada con el color del modo y un pie con el modo y el contexto. Tema claro u oscuro según tu terminal (`LIXBON_THEME`, `/config` → Tema).
- El turno del agente se lee por bloques: el pensamiento queda plegado («Pensó 4.2 s»), las lecturas seguidas se agrupan («Exploró 4 archivos · 2 búsquedas»), las ediciones muestran el diff con resaltado de sintaxis y los comandos su salida con las primeras y las últimas líneas. Ctrl+O despliega todo y un clic en un bloque, solo ese.
- Nuevo inicio de sesión sin correo ni contraseña en la terminal: con tu cuenta de lixbon.com en el navegador (vuelve solo a la terminal; en SSH se pega la dirección) o con una API key enmascarada. La clave del CLI ya no cierra la sesión de la app de escritorio. Sin terminal: `lixbon setup --api-key`.
- Aprobaciones, preguntas del agente y selectores en paneles: se elige con ↑↓, con el número o con un clic. `/model` muestra qué sabe hacer cada modelo (visión, herramientas, razona) y su contexto, y se abre también con un clic en el modelo de la barra.
- Menú `@` para adjuntar archivos del proyecto (respeta `.gitignore`), menú `/` agrupado con filtro difuso y `?` con la caja vacía para ver los atajos.
- Las imágenes pegadas o arrastradas a la terminal se muestran como fichas con su tamaño, y se avisa si el modelo no ve imágenes.
- Las claves de los proveedores se piden sin mostrarlas, y `/key <clave>` ya no queda a la vista en el historial.

## 2.3.0-go.6
- La rueda del ratón desplaza el chat sin activar nada y desaparece `/mouse`. Arrastrar con el ratón selecciona texto y lo copia al soltar.
- Nuevo Ctrl+T: abre un visor con la conversación, las herramientas ejecutadas y lo que el modelo está escribiendo ahora. Se mueve con las flechas, RePág/AvPág, Inicio/Fin o la rueda; q, Esc o Ctrl+T lo cierran.
- `/clear` mantiene el logo y la cabecera, y la cabecera muestra ahora la carpeta de trabajo en su propia línea.

## 2.3.0-go.5
- Corregido: con proveedores externos (OpenRouter, Kilo, OpenAI, Gemini…) las herramientas del agente fallaban con «Herramienta no soportada». Esos proveedores envían cada llamada partida en fragmentos y el CLI los trataba como llamadas distintas; ahora los une. El agente también conserva los campos extra que algunos proveedores exigen devolver (p. ej. `extra_content` de Gemini) y da un id a las llamadas que llegan sin él.

## 2.3.0-go.4
- `lixbon` arranca aunque no tengas sesión en lixbon.com o tu clave haya dejado de valer: abre el chat con un aviso y desde `/provider` puedes conectar otro proveedor (OpenRouter, OpenAI, Kilo, LM Studio, Ollama…) sin salir.
- Nuevo `lixbon auth login | list | logout` para conectar proveedores y gestionar sus claves, al estilo de `opencode auth`. La clave se pide sin mostrarla.
- `/provider` → «Añadir proveedor» ofrece una lista de presets (OpenRouter, OpenAI, Kilo, Groq, DeepSeek, Mistral, Gemini, LM Studio, Ollama) y solo pide la clave.
- Corregido: el proveedor activo y los campos de `config.json` podían quedar desajustados (por ejemplo, la clave de Kilo enviada a lixbon.com). Ahora manda siempre el perfil guardado y el archivo se corrige al cargarlo.
- Los errores de clave rechazada indican el comando que existe (`lixbon auth login NOMBRE`) en lugar de `init`.

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
