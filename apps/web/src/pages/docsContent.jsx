// docsContent.jsx — contenido de lixbon Docs. Cada sección es un componente que
// recibe `base` (origen del gateway) para los ejemplos. El índice, los títulos
// y las descripciones viven en docsIndex.js (lo comparte el sitemap).
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CodeBlock } from '../components/CodeBlock';
import { IconShield } from '../components/Icons';
import { DOCS_INDEX } from './docsIndex';

function Callout({ children }) {
  return (
    <div className="docs__callout">
      <IconShield size={17} />
      <p>{children}</p>
    </div>
  );
}

function Introduccion() {
  return (
    <>
      <h1>¿Qué es lixbon?</h1>
      <p className="docs__lead">
        lixbon es una plataforma de IA que corre sobre un clúster de GPUs propio.
        Chateas con modelos de lenguaje desde la web, programas con un agente desde
        la terminal o el IDE, diseñas sitios en Visuals y, si desarrollas, integras
        los mismos modelos en tu código con una API compatible con OpenAI.
      </p>

      <h2>Cómo funciona</h2>
      <p>
        Tus mensajes llegan a un <strong>gateway</strong> que los enruta al nodo GPU
        más adecuado del clúster y te devuelve la respuesta en streaming, token a
        token. No dependes de un proveedor externo: la inferencia ocurre en hardware
        propio, y el orquestador reparte la carga y evita los nodos caídos. Cada
        tarea (chat, visión, autocompletado de código, embeddings) la atiende el
        modelo que mejor la sirve.
      </p>

      <h2>Formas de usar lixbon</h2>
      <ul>
        <li><strong><a href="/docs/chat">Chat web</a></strong> — la forma más rápida de empezar, sin instalar nada.</li>
        <li><strong><a href="/docs/visuals">Visuals</a></strong> — diseña landings, dashboards, emails, logos y prototipos navegables hablando con el modelo.</li>
        <li><strong><a href="/docs/cli">CLI</a></strong> — chat en la terminal con modo agente: lee y edita tu proyecto, ejecuta comandos y hace commits.</li>
        <li><strong><a href="/docs/desktop">App de escritorio</a></strong> — un IDE con autocompletado, chat y agente integrados.</li>
        <li><strong><a href="/docs/remote">Remote</a></strong> — sigue y dirige una sesión del agente desde el móvil.</li>
        <li><strong><a href="/docs/api">API</a></strong> — endpoints compatibles con OpenAI para tus propias aplicaciones.</li>
      </ul>

      <Callout>
        ¿Listo para empezar? Continúa con <a href="/docs/primeros-pasos">Primeros pasos</a>.
      </Callout>
    </>
  );
}

function PrimerosPasos() {
  return (
    <>
      <h1>Primeros pasos</h1>
      <p className="docs__lead">
        Crea tu cuenta y envía tu primer mensaje en menos de un minuto.
      </p>

      <h2>1. Crea una cuenta</h2>
      <p>
        Entra al <a href="/chat">chat</a> y regístrate con tu correo, nombre y una
        contraseña. Al registrarte recibes el plan <strong>Gratuito</strong>, suficiente
        para probar la plataforma: 30 mensajes al día y 150 000 tokens al mes.
      </p>

      <h2>2. Escribe tu primer mensaje</h2>
      <p>
        Escribe en el cuadro de texto y pulsa Enter. La respuesta aparece en
        streaming. Cada conversación se guarda en tu historial y puedes retomarla,
        renombrarla, compartirla por enlace o eliminarla cuando quieras.
      </p>

      <h2>3. Elige un modelo</h2>
      <p>
        En el compositor puedes cambiar de modelo. Si no eliges ninguno, el gateway
        usa el modelo asignado al rol de chat. Los modelos con razonamiento muestran
        su «pensamiento» antes de la respuesta.
      </p>

      <h2>4. Diseña algo en Visuals</h2>
      <p>
        En <a href="/visuals">Visuals</a> describes una web, un dashboard o un
        prototipo y el modelo lo construye en HTML; luego lo afinas hablando con él o
        tocando los elementos en el lienzo. Más en <a href="/docs/visuals">Visuals</a>.
      </p>

      <h2>5. Lleva lixbon a tu terminal o a tu editor</h2>
      <p>
        Cuando quieras usarlo mientras programas, instala el{' '}
        <a href="/docs/cli">CLI</a> o la <a href="/docs/desktop">app de escritorio</a>.
        Ambos entran con tu correo y contraseña o con una API key.
      </p>
    </>
  );
}

function ChatWeb() {
  return (
    <>
      <h1>Chat web</h1>
      <p className="docs__lead">
        El chat de <a href="/chat">lixbon.com</a> es la puerta de entrada: conversaciones con
        streaming, historial, adjuntos y búsqueda web, sin instalar nada.
      </p>

      <h2>Modelos y razonamiento</h2>
      <p>
        El selector del compositor lista los modelos activos del clúster. Los que
        razonan (DeepSeek-R1, Qwen 3, gpt-oss…) muestran su pensamiento en un bloque
        plegable antes de la respuesta; el nivel de razonamiento se ajusta solo según
        el modelo y la tarea.
      </p>

      <h2>Adjuntos</h2>
      <p>
        Con el clip, pegando o arrastrando puedes adjuntar imágenes y documentos
        (PDF, Word, texto, Markdown, CSV, JSON, código…). Las imágenes las lee el
        modelo de visión del clúster; los documentos se convierten a texto y entran
        en el contexto de la conversación.
      </p>

      <h2>Dictado y búsqueda web</h2>
      <ul>
        <li>El <strong>micrófono</strong> dicta el mensaje con el reconocimiento de voz del navegador.</li>
        <li>El <strong>globo</strong> activa la búsqueda en internet en cada respuesta; sin activarlo, el modelo decide cuándo buscar.</li>
      </ul>

      <h2>Historial y enlaces públicos</h2>
      <p>
        Las conversaciones se guardan en la barra lateral: renómbralas, búscalas o
        elimínalas. Desde el menú de una conversación puedes crear un{' '}
        <strong>enlace público</strong> de solo lectura y dejar de compartirlo cuando quieras.
        Si desactivas «Historial de conversaciones» en{' '}
        <a href="/account/privacidad">Ajustes → Privacidad</a>, los chats nuevos no se guardan.
      </p>

      <h2>Límites</h2>
      <p>
        El chat con sesión consume la cuota de tu plan (mensajes al día y tokens al
        mes). Cuando llegas al límite, la interfaz te indica cuándo se reinicia y
        cómo <a href="/planes">mejorar el plan</a>.
      </p>
    </>
  );
}

function Visuals() {
  return (
    <>
      <h1>Visuals</h1>
      <p className="docs__lead">
        En <a href="/visuals">Visuals</a> describes lo que quieres y el modelo lo
        construye en HTML con Tailwind; luego lo afinas hablando con él o tocándolo en
        el lienzo. Cada diseño vive en su propia conversación, con versiones.
      </p>

      <h2>Qué puedes diseñar</h2>
      <ul>
        <li><strong>Landing page</strong>, <strong>Componente</strong> (tarjeta, tabla, formulario…), <strong>Dashboard</strong> y <strong>Email</strong> (tablas y estilos en línea).</li>
        <li><strong>Logo / SVG</strong>: logotipos e ilustraciones vectoriales.</li>
        <li><strong>Prototipo</strong>: varias pantallas enlazadas entre sí (<code>index.html</code>, <code>contacto.html</code>…), navegables desde la vista previa.</li>
        <li><strong>Imagen</strong>: generación de imágenes, cuando hay un nodo del clúster que las genera.</li>
      </ul>

      <h2>Design systems</h2>
      <p>
        Antes de pedir el diseño puedes fijar un design system (Lixbon, Editorial,
        Minimal, Corporativo, Vibrante, Dark tech) o definir el tuyo con acento, fondo,
        texto, fuentes y tono. Se aplica a todas las páginas y versiones del diseño.
      </p>

      <h2>El editor</h2>
      <ul>
        <li><strong>Páginas</strong>: el chip junto al nombre cambia de página o muestra el <strong>Lienzo</strong> con todas a la vez.</li>
        <li><strong>Versiones</strong>: cada respuesta del modelo es una versión; vuelve a cualquiera desde el chip <code>v3 ▾</code>.</li>
        <li><strong>Seleccionar</strong>: haz clic en un elemento de la vista previa para cambiar su texto o sus estilos a mano, o para pedirle al modelo un cambio solo sobre ese elemento.</li>
        <li><strong>Código</strong>: el HTML de la página actual.</li>
        <li><strong>Presentar</strong>: abre el diseño a pantalla completa en otra pestaña, con la navegación entre páginas funcionando.</li>
      </ul>
      <p>
        Las ediciones pequeñas no reescriben la página: el modelo envía bloques de
        búsqueda y reemplazo que se aplican sobre la versión anterior. Si un bloque no
        encaja, la página se queda como estaba y puedes pedir el archivo completo.
      </p>

      <h2>Compartir y exportar</h2>
      <ul>
        <li><strong>Enlace público</strong>: un enlace de solo lectura (<code>lixbon.com/s/…</code>) que puedes desactivar cuando quieras.</li>
        <li><strong>Lixbon CLI</strong>: copia el comando <code>/visual &lt;id&gt;</code> y pégalo en el CLI para convertir el diseño en un proyecto real (React + Vite, con API Express si la pides).</li>
        <li><strong>Descargar</strong>: un <code>.zip</code> con las páginas HTML (o el archivo suelto si es una sola), y <strong>Copiar el código</strong> de la página actual.</li>
      </ul>

      <Callout>
        Visuals está incluido en los planes <strong>Pro</strong> y <strong>Advance</strong>
        y consume la cuota de tu plan igual que el chat. Con el plan Gratuito puedes
        ver la galería, pero no generar ni editar diseños.
      </Callout>
    </>
  );
}

function Cli({ base }) {
  return (
    <>
      <h1>CLI</h1>
      <p className="docs__lead">
        El CLI de lixbon te deja chatear con el clúster desde la terminal y trabajar
        con un agente que lee y edita tu proyecto, ejecuta comandos y hace commits.
        Requiere Python 3.10 o superior.
      </p>

      <h2>Instalación en Windows</h2>
      <p>Abre <strong>PowerShell</strong> y ejecuta:</p>
      <CodeBlock code={`irm ${base}/install.ps1 | iex`} />
      <p>
        Esto descarga el CLI en <code>%USERPROFILE%\\.lixbon</code> y agrega el comando{' '}
        <code>lixbon</code> a tu PATH de usuario. Abre una terminal nueva para que el
        comando quede disponible.
      </p>

      <h2>Instalación en Linux y macOS</h2>
      <p>Abre tu <strong>terminal</strong> y ejecuta:</p>
      <CodeBlock code={`curl -fsSL ${base}/install.sh | bash`} />
      <p>
        Instala el CLI en <code>~/.lixbon</code> y crea el comando <code>lixbon</code>{' '}
        en <code>~/.local/bin</code>. Si <code>lixbon</code> no se reconoce, añade esa
        carpeta a tu PATH:
      </p>
      <CodeBlock code={`export PATH="$HOME/.local/bin:$PATH"`} />

      <h2>Primer uso</h2>
      <p>
        Ejecuta <code>lixbon</code>: la primera vez se abre el inicio de sesión
        interactivo, con tu correo y contraseña o pegando una API key{' '}
        <code>lixbon_sk_…</code> (la generas en <a href="/account/cuenta">Ajustes → Cuenta</a>).
        Después eliges el modelo y ya estás chateando. Escribe <code>/</code> para ver
        todos los comandos.
      </p>
      <CodeBlock code={`lixbon`} />

      <h2>Modos de trabajo</h2>
      <table className="docs__table">
        <thead><tr><th>Modo</th><th>Qué hace</th></tr></thead>
        <tbody>
          <tr><td><code>ask</code></td><td>Chat normal. Adjunta imágenes con <code>@ruta.png</code> o <code>/paste</code>.</td></tr>
          <tr><td><code>agent</code></td><td>El modelo usa herramientas sobre tu carpeta de trabajo: lee y edita archivos, ejecuta comandos, hace commits. Cada herramienta pide aprobación salvo que actives <code>/approve</code> o la incluyas en <code>/allow</code>.</td></tr>
          <tr><td><code>plan</code></td><td>Sobre el modo agente: solo explora y propone un plan, sin tocar nada (<code>/plan on</code>).</td></tr>
          <tr><td><code>delegate</code></td><td>Un clasificador analiza la petición (intención, complejidad, dominio, riesgo) y la enruta al modelo del clúster que mejor la resuelve.</td></tr>
        </tbody>
      </table>
      <p>
        En los modos <code>agent</code> y <code>plan</code> el CLI pide el nivel de
        razonamiento alto a los modelos que lo admiten: un agente que piensa más se
        equivoca menos al editar.
      </p>

      <h2>Comandos</h2>
      <table className="docs__table">
        <thead><tr><th>Comando</th><th>Qué hace</th></tr></thead>
        <tbody>
          <tr><td><code>/model [nombre]</code></td><td>Cambiar de modelo (sin argumento abre el selector)</td></tr>
          <tr><td><code>/mode [ask|agent|delegate]</code></td><td>Cambiar modo de trabajo</td></tr>
          <tr><td><code>/new</code> · <code>/clear</code></td><td>Empezar una conversación nueva · vaciar el contexto</td></tr>
          <tr><td><code>/compact</code></td><td>Compactar la conversación para liberar contexto</td></tr>
          <tr><td><code>/history</code></td><td>Ver y reabrir conversaciones anteriores</td></tr>
          <tr><td><code>/web [auto|on|off]</code></td><td>Búsqueda web: el modelo decide, siempre o nunca</td></tr>
          <tr><td><code>/image &lt;ruta&gt;</code> · <code>/paste</code></td><td>Adjuntar una imagen del disco o del portapapeles (Alt+V)</td></tr>
          <tr><td><code>/copy</code> · <code>/save [ruta]</code></td><td>Copiar la última respuesta · guardar la conversación en Markdown</td></tr>
          <tr><td><code>/plan [on|off]</code></td><td>Modo plan: el agente solo explora y propone</td></tr>
          <tr><td><code>/approve [on|off]</code></td><td>Auto-aprobar las herramientas del agente</td></tr>
          <tr><td><code>/allow [comando]</code></td><td>Comandos que el agente ejecuta sin preguntar (npm test, pytest…)</td></tr>
          <tr><td><code>/todo</code> · <code>/tools</code></td><td>Pasos del agente · herramientas disponibles</td></tr>
          <tr><td><code>/diff [ruta]</code> · <code>/undo</code></td><td>Cambios sin confirmar · revertir lo que tocó el último turno</td></tr>
          <tr><td><code>/run &lt;comando&gt;</code> · <code>/ps</code></td><td>Ejecutar un comando y darle la salida al modelo · procesos en segundo plano</td></tr>
          <tr><td><code>/check [on|off]</code></td><td>Verificar con el linter cada archivo que edita el agente</td></tr>
          <tr><td><code>/commit [mensaje]</code></td><td>Commit de los cambios con mensaje redactado por el modelo</td></tr>
          <tr><td><code>/workspace [ruta]</code> · <code>/init</code></td><td>Carpeta de trabajo · generar <code>LIXBON.md</code> con el contexto del proyecto</td></tr>
          <tr><td><code>/mcp</code></td><td>Servidores MCP conectados y sus herramientas</td></tr>
          <tr><td><code>/visual &lt;id o enlace&gt; [stack]</code></td><td>Traer un diseño de Visuals y replicarlo como proyecto (<code>react</code>, <code>react api</code> o el stack que escribas)</td></tr>
          <tr><td><code>/remote</code></td><td>Controlar esta sesión desde el móvil o la web (enlace + QR)</td></tr>
          <tr><td><code>/status</code> · <code>/cost</code> · <code>/usage</code></td><td>Estado de la sesión · tokens consumidos · uso global de la cuenta</td></tr>
          <tr><td><code>/nodes</code></td><td>Ver los nodos del clúster</td></tr>
          <tr><td><code>/login</code> · <code>/logout</code> · <code>/key &lt;api_key&gt;</code></td><td>Sesión de esta máquina</td></tr>
          <tr><td><code>/config</code> · <code>/bar</code> · <code>/doctor</code></td><td>Ajustes · barra de estado · diagnóstico de terminal y conexión</td></tr>
          <tr><td><code>/update</code></td><td>Actualizar el CLI a la última versión</td></tr>
        </tbody>
      </table>

      <h2>Replicar un diseño de Visuals</h2>
      <p>
        En Visuals, <strong>Compartir → Lixbon CLI</strong> copia el comando. En el CLI:
      </p>
      <CodeBlock code={`/visual 56f5bda7-… react api`} />
      <p>
        El CLI descarga las páginas HTML a una carpeta, pasa a modo agente y monta el
        proyecto en <code>&lt;nombre&gt;-app/</code>: React 18 + Vite con una ruta por
        página, Tailwind por npm y, con <code>api</code>, un servidor Express para los
        formularios. Sin stack, pregunta qué hacer con el diseño.
      </p>

      <h2>Instalación manual</h2>
      <p>
        Si prefieres no ejecutar el script, descarga{' '}
        <a href={`${base}/install/client_cli.py`}>client_cli.py</a> y córrelo con Python:
      </p>
      <CodeBlock code={`python client_cli.py init --base-url ${base}/v1`} />
      <CodeBlock code={`python client_cli.py chat`} />
    </>
  );
}

function Desktop() {
  return (
    <>
      <h1>App de escritorio</h1>
      <p className="docs__lead">
        La app de escritorio es un IDE ligero con lixbon dentro: editor con
        autocompletado, chat y agente sobre tu proyecto, para Windows, con
        actualizaciones automáticas.
      </p>

      <h2>Instalación</h2>
      <p>
        Descarga el instalador desde <a href="/aplicaciones">Aplicaciones</a> y
        ejecútalo. Inicia sesión con tu correo: la app crea y gestiona su propia API
        key («lixbon Desktop»), o entra pegando una key existente.
      </p>

      <h2>Qué incluye</h2>
      <ul>
        <li><strong>Editor</strong> con resaltado, búsqueda y reemplazo, y <strong>autocompletado fantasma</strong> (estilo Copilot) servido por el modelo de código del clúster.</li>
        <li><strong>Chat</strong> con @-menciones a archivos del proyecto.</li>
        <li><strong>Agente</strong>: las mismas herramientas del CLI (editar, ejecutar, commits) con aprobación por paso.</li>
        <li><strong>Remote</strong>: sigue la sesión desde el móvil (<a href="/docs/remote">ver Remote</a>).</li>
      </ul>

      <h2>Actualizaciones y canales</h2>
      <p>
        La app se actualiza sola cuando publicamos una versión nueva: te avisa y aplica
        la actualización firmada sin reinstalar. Hay dos canales: <strong>stable</strong>{' '}
        (recomendado) y <strong>beta</strong> (versiones nuevas antes de tiempo). El
        historial de versiones está en <a href="/novedades">Novedades</a>.
      </p>

      <h2>App de Android</h2>
      <p>
        En <a href="/aplicaciones">Aplicaciones</a> también está la app de Android
        (APK, Android 7.0 o superior): chat con tu cuenta y la sección Remote para
        dirigir sesiones del CLI o del IDE desde el teléfono.
      </p>

      <Callout>
        Si aún no ves un instalador en Aplicaciones, es que todavía no se ha publicado
        una versión; mientras tanto puedes usar el <a href="/docs/cli">CLI</a> o el{' '}
        <a href="/chat">chat web</a>.
      </Callout>
    </>
  );
}

function Remote() {
  return (
    <>
      <h1>Remote</h1>
      <p className="docs__lead">
        Estás trabajando con el agente en el CLI o en el IDE y tienes que salir.
        Con <code>/remote</code> la sesión sigue en tu máquina y tú la diriges desde
        el móvil o desde cualquier navegador.
      </p>

      <h2>Cómo se activa</h2>
      <ol>
        <li>En el CLI o el IDE escribe <code>/remote</code>. Sin abrir puertos ni configurar nada.</li>
        <li>La sesión aparece en la sección <strong>Remote</strong> de la app de Android, y se genera un enlace <code>lixbon.com/remote/…</code> con su código QR para quien no tenga la app.</li>
        <li>Desde el móvil o la web ves el transcript en vivo, envías prompts nuevos, interrumpes el turno y respondes a las aprobaciones de herramientas.</li>
      </ol>

      <h2>Seguridad</h2>
      <ul>
        <li>El enlace identifica la sesión, pero <strong>siempre exige iniciar sesión</strong> con la cuenta dueña: sin tu contraseña nadie entra aunque tenga el enlace.</li>
        <li>Todo se ejecuta en la máquina de origen: el móvil es un mando a distancia y nunca ejecuta herramientas.</li>
        <li><code>/remote stop</code>, o cerrar el CLI o el IDE, termina la sesión y revoca el enlace.</li>
      </ul>

      <p>
        Con sesión iniciada, <a href="/remote">lixbon.com/remote</a> lista tus sesiones
        activas.
      </p>
    </>
  );
}

function ApiDocs({ base }) {
  return (
    <>
      <h1>API</h1>
      <p className="docs__lead">
        lixbon expone una API <strong>compatible con OpenAI</strong>. Si ya usas el SDK
        de OpenAI o cualquier cliente compatible, solo cambia la URL base y la API key.
      </p>

      <h2>Autenticación</h2>
      <p>
        Genera una API key en <a href="/account/cuenta">Ajustes → Cuenta</a>. Se muestra
        una única vez al crearla; guárdala. Envíala en la cabecera <code>Authorization</code>:
      </p>
      <CodeBlock code={`Authorization: Bearer lixbon_sk_tu_clave`} />

      <h2>Endpoint base</h2>
      <CodeBlock code={`${base}/v1`} />

      <h2>Listar modelos</h2>
      <CodeBlock label="cURL" code={`curl ${base}/v1/models -H "Authorization: Bearer lixbon_sk_tu_clave"`} />
      <p>
        El campo <code>model</code> es opcional: si no lo envías, el gateway usa el
        modelo asignado al rol de chat.
      </p>

      <h2>Chat completions (streaming)</h2>
      <CodeBlock
        label="cURL"
        code={`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_tu_clave" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hola"}],"stream":true}'`}
      />
      <p>
        La respuesta llega como eventos <code>text/event-stream</code> en el mismo
        formato de OpenAI (<code>data: {'{...}'}</code> y <code>data: [DONE]</code> al
        final). Sin <code>stream</code>, la respuesta es un JSON completo con{' '}
        <code>usage</code>.
      </p>

      <h2>Con el SDK de OpenAI (Python)</h2>
      <CodeBlock
        label="Python"
        code={`from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="lixbon_sk_tu_clave")

stream = client.chat.completions.create(
    model="qwen3.5:27b",
    messages=[{"role": "user", "content": "Hola"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`}
      />

      <h2>Errores</h2>
      <table className="docs__table">
        <thead><tr><th>Código</th><th>Significado</th></tr></thead>
        <tbody>
          <tr><td><code>401</code></td><td>API key ausente, revocada o incorrecta.</td></tr>
          <tr><td><code>402 insufficient_credits</code></td><td>Sin saldo de créditos: recarga en <a href="/account/facturacion">Facturación</a>.</td></tr>
          <tr><td><code>429</code></td><td>Superaste las peticiones por minuto de tu plan.</td></tr>
          <tr><td><code>503 model_not_available</code></td><td>Ningún nodo sirve ese modelo ahora mismo; prueba otro de <code>/v1/models</code>.</td></tr>
        </tbody>
      </table>

      <Callout>
        El uso de la API se paga con <strong>créditos prepago</strong> según los tokens
        que consumas: consulta <a href="/docs/precios-api">Precios de la API</a> y las
        recetas de integración en <a href="/docs/usar-api-key">Usar tu API key</a>.
      </Callout>
    </>
  );
}

function UsarApiKey({ base }) {
  return (
    <>
      <h1>Usar tu API key</h1>
      <p className="docs__lead">
        Tu API key <code>lixbon_sk_…</code> funciona en cualquier herramienta compatible
        con la API de OpenAI: SDKs oficiales, editores con IA, agentes y tus propios
        scripts. Aquí tienes las recetas más comunes.
      </p>

      <h2>1. Crea tu key</h2>
      <p>
        Ve a <a href="/account/cuenta">Ajustes → Cuenta → API keys</a> y pulsa
        «Nueva key». Se muestra <strong>una sola vez</strong>; guárdala en un gestor de
        secretos. Si la pierdes, desactívala y crea otra. El número de keys depende de
        tu <a href="/docs/planes">plan</a>.
      </p>

      <h2>2. Recarga créditos</h2>
      <p>
        Las peticiones con API key se pagan con <strong>créditos prepago</strong> según los
        tokens que uses (ver <a href="/docs/precios-api">Precios de la API</a>). Recarga
        saldo en <a href="/account/facturacion">Ajustes → Facturación</a>. Sin saldo, la
        API responde <code>402 insufficient_credits</code>.
      </p>

      <h2>La configuración universal</h2>
      <p>Cualquier cliente OpenAI-compatible solo necesita dos valores:</p>
      <table className="docs__table">
        <thead><tr><th>Parámetro</th><th>Valor</th></tr></thead>
        <tbody>
          <tr><td>Base URL</td><td><code>{base}/v1</code></td></tr>
          <tr><td>API key</td><td><code>lixbon_sk_tu_clave</code></td></tr>
        </tbody>
      </table>

      <h2>cURL</h2>
      <CodeBlock
        label="cURL"
        code={`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_tu_clave" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hola"}]}'`}
      />

      <h2>Python (SDK de OpenAI)</h2>
      <CodeBlock
        label="Python"
        code={`from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="lixbon_sk_tu_clave")

resp = client.chat.completions.create(
    messages=[{"role": "user", "content": "Hola"}],
)
print(resp.choices[0].message.content)`}
      />

      <h2>JavaScript / Node (SDK de OpenAI)</h2>
      <CodeBlock
        label="JavaScript"
        code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}/v1",
  apiKey: "lixbon_sk_tu_clave",
});

const resp = await client.chat.completions.create({
  messages: [{ role: "user", content: "Hola" }],
});
console.log(resp.choices[0].message.content);`}
      />

      <h2>continue.dev (VS Code / JetBrains)</h2>
      <CodeBlock
        label="config.yaml"
        code={`models:
  - name: lixbon
    provider: openai
    model: qwen3.5:27b
    apiBase: ${base}/v1
    apiKey: lixbon_sk_tu_clave`}
      />

      <h2>Otras herramientas</h2>
      <p>
        En cualquier app que pida un «proveedor OpenAI compatible» (Open WebUI,
        LibreChat, aider, LangChain, LlamaIndex…), usa la misma pareja base URL + key.
        Lista los modelos disponibles con <code>GET {base}/v1/models</code>.
      </p>

      <Callout>
        Consulta tu consumo detallado por día y modelo en{' '}
        <a href="/account/uso">Ajustes → Uso</a>, y el costo por modelo en{' '}
        <a href="/docs/precios-api">Precios de la API</a>.
      </Callout>
    </>
  );
}

function PreciosApi() {
  const [pricing, setPricing] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get('/api/pricing')
      .then((res) => setPricing(res.data.pricing))
      .catch(() => setError(true));
  }, []);

  const fmt = (v) => `$${v.toFixed(2)}`;

  return (
    <>
      <h1>Precios de la API</h1>
      <p className="docs__lead">
        El uso de la API con tu key se paga con <strong>créditos prepago</strong>: compras
        saldo una vez y cada petición descuenta según los tokens reales que consuma,
        a la tarifa del modelo. Sin suscripciones ni sorpresas: si no la usas, no gastas.
      </p>

      <h2>Tarifas por modelo</h2>
      <p>
        Precios en USD por <strong>millón de tokens</strong>. Con créditos solo se pueden
        usar los modelos de esta tabla: un modelo sin tarifa publicada responde{' '}
        <code>403 model_not_priced</code> en vez de cobrarse a un precio que no conoces.
      </p>
      {error && (
        <p>No se pudieron cargar las tarifas ahora mismo. Intenta de nuevo en unos minutos.</p>
      )}
      {pricing === null && !error && <p>Cargando tarifas…</p>}
      {pricing && (
        <table className="docs__table docs__table--tarifas">
          <thead>
            <tr><th>Modelo</th><th>Id en la API</th><th className="num">Entrada</th><th className="num">Salida</th></tr>
          </thead>
          <tbody>
            {pricing.map((p) => (
              <tr key={p.model_prefix}>
                <td>{p.display_name || p.model_prefix}</td>
                <td><code>{p.model_prefix}</code></td>
                <td className="num">{fmt(p.input_usd_per_mtok)}</td>
                <td className="num">{fmt(p.output_usd_per_mtok)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="docs__nota">Precios por millón de tokens. Un id terminado en <code>:</code> cubre todas las variantes de esa familia.</p>

      <h2>Cómo se calcula el costo</h2>
      <p>
        Cada respuesta de la API incluye <code>usage</code> con los tokens de entrada
        (<code>prompt_tokens</code>) y salida (<code>completion_tokens</code>). El costo es:
      </p>
      <CodeBlock code={`costo = prompt_tokens × tarifa_entrada / 1 000 000
      + completion_tokens × tarifa_salida / 1 000 000`} />
      <p>
        Ejemplo con la tarifa estándar ($0.20 entrada / $0.60 salida): una petición con
        1 000 tokens de entrada y 2 000 de salida cuesta $0.0014. El costo se descuenta al
        terminar la respuesta, cuando ya se conocen los tokens reales.
      </p>

      <h2>Packs de recarga</h2>
      <table className="docs__table">
        <thead><tr><th>Pack</th><th>Precio</th><th>Saldo</th></tr></thead>
        <tbody>
          <tr><td>Starter</td><td>$5.00</td><td>$5.00 de créditos</td></tr>
          <tr><td>Plus</td><td>$20.00</td><td>$20.00 de créditos</td></tr>
          <tr><td>Power</td><td>$50.00</td><td>$50.00 de créditos</td></tr>
        </tbody>
      </table>
      <ul>
        <li>Se compran en <a href="/account/facturacion">Ajustes → Facturación</a> con tarjeta, en un pago único.</li>
        <li>Los créditos <strong>no caducan</strong> y solo se descuentan por uso real de la API.</li>
        <li>El chat de la web, de la app y de Visuals con tu sesión <strong>no</strong> consume créditos: va con tu plan.</li>
        <li>Con la <strong>recarga automática</strong> el pack que elijas se cobra solo cuando el saldo baja de $5 (ver <a href="/docs/facturacion">Facturación</a>).</li>
      </ul>

      <h2>Sin saldo</h2>
      <p>
        Cuando el saldo llega a cero, la API responde <code>402</code> con
        <code> insufficient_credits</code> y tu saldo actual. Recarga y la key vuelve a
        funcionar al instante; las keys nunca se bloquean por otra razón de pago.
      </p>

      <Callout>
        Tu consumo detallado (tokens y costo por día y modelo) está siempre visible en{' '}
        <a href="/account/uso">Ajustes → Uso</a>.
      </Callout>
    </>
  );
}

function Planes() {
  return (
    <>
      <h1>Planes y límites</h1>
      <p className="docs__lead">
        Cada cuenta tiene un plan que define cuántos mensajes y tokens puedes usar con
        tu sesión (web, app, CLI, Visuals), cuántas API keys puedes tener y cuántas
        peticiones por minuto admite la API.
      </p>

      <h2>Los tres planes</h2>
      <table className="docs__table">
        <thead>
          <tr><th>Plan</th><th>Precio</th><th>Mensajes/día</th><th>Tokens/mes</th><th>API keys</th><th>Peticiones/min</th><th>Visuals</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Gratuito</strong></td><td>$0</td><td>30</td><td>150 000</td><td>1</td><td>10</td><td>No</td></tr>
          <tr><td><strong>Pro</strong></td><td>$9.90 / mes</td><td>500</td><td>5 000 000</td><td>5</td><td>60</td><td>Sí</td></tr>
          <tr><td><strong>Advance</strong></td><td>$24.90 / mes</td><td>Ilimitados</td><td>20 000 000</td><td>20</td><td>120</td><td>Sí</td></tr>
        </tbody>
      </table>
      <p>
        Todos los planes acceden a todos los modelos activos del clúster. Los precios
        vigentes y el cambio de plan están en la página de <a href="/planes">Planes</a>.
      </p>

      <h2>Cómo se cuentan los límites</h2>
      <ul>
        <li>Los <strong>mensajes por día</strong> se reinician cada día a medianoche (UTC).</li>
        <li>Los <strong>tokens por mes</strong> se reinician el día 1 de cada mes.</li>
        <li>Puedes ver tu consumo en tiempo real en <a href="/account/uso">Ajustes → Uso</a>.</li>
      </ul>

      <h2>Cuándo chocas con un límite</h2>
      <p>
        Si superas tu cuota, la plataforma te lo dice con claridad e indica cuándo se
        reinicia. Para levantar el límite, mejora tu plan: el cambio aplica al instante y
        hoy solo se cobra la diferencia prorrateada (ver <a href="/docs/facturacion">Facturación</a>).
      </p>

      <h2>¿Y la API?</h2>
      <p>
        Las peticiones con API key <strong>no</strong> consumen la cuota del plan: se pagan
        con <a href="/docs/precios-api">créditos prepago</a> por tokens y pueden usar
        cualquier modelo del clúster. Del plan solo se conservan las peticiones por
        minuto y el número de keys.
      </p>
    </>
  );
}

function Facturacion() {
  return (
    <>
      <h1>Facturación y pagos</h1>
      <p className="docs__lead">
        Todo se gestiona en <a href="/account/facturacion">Ajustes → Facturación</a>: el
        plan, las tarjetas, los cobros, las facturas y los créditos de la API. Los pagos
        los procesa <strong>Stripe</strong>; el número de tu tarjeta nunca pasa por lixbon.
      </p>

      <h2>Suscribirte a un plan</h2>
      <ol>
        <li>En <a href="/planes">Planes</a> elige Pro o Advance. Se abre el pago sin salir de lixbon.</li>
        <li>Elige una tarjeta guardada o añade una nueva (el formulario lo sirve Stripe).</li>
        <li>Si tu banco pide confirmación (3-D Secure), se abre su ventana; termínala ahí.</li>
        <li>El plan queda activo al instante y recibes un correo con el detalle. Se renueva cada mes con la misma tarjeta.</li>
      </ol>

      <h2>Cambiar de plan</h2>
      <ul>
        <li><strong>Subir</strong> (Pro → Advance): hoy se cobra solo la diferencia prorrateada del mes; a partir de la renovación pagas el precio completo. Si el banco pide confirmación, el cambio se aplica al confirmar.</li>
        <li><strong>Bajar</strong> (Advance → Pro): hoy no se cobra nada; lo que te queda pagado del plan caro se descuenta de las próximas facturas. Los límites del plan nuevo aplican ya.</li>
      </ul>

      <h2>Cancelar y reactivar</h2>
      <p>
        <strong>Cancelar</strong> mantiene el plan hasta el final del periodo pagado y no lo
        renueva; después pasas al Gratuito. Mientras no llegue esa fecha puedes{' '}
        <strong>reactivarlo</strong> con un clic y se vuelve a renovar. No hay devoluciones
        de periodos ya cobrados.
      </p>

      <h2>Si un cobro falla</h2>
      <p>
        Si la renovación no entra, te llega un correo con el importe, el enlace para
        pagar la factura o cambiar la tarjeta, y la fecha del siguiente intento. Stripe
        reintenta durante unos días y el plan sigue activo mientras tanto; si todos los
        intentos fallan, la suscripción se cancela y pasas al plan Gratuito.
      </p>

      <h2>Tarjetas</h2>
      <ul>
        <li>Puedes guardar varias tarjetas y elegir la <strong>predeterminada</strong>, que es con la que se renueva el plan.</li>
        <li>La única tarjeta de una suscripción activa no se puede quitar: añade otra antes.</li>
        <li>Si quitas la tarjeta de la recarga automática, la recarga se apaga.</li>
        <li>Las tarjetas se guardan en Stripe con un SetupIntent: lixbon solo conoce la marca, los últimos cuatro dígitos y la fecha de vencimiento.</li>
      </ul>

      <h2>Cobros y facturas</h2>
      <p>
        En Facturación ves los últimos cobros (renovaciones, cambios de plan y recargas)
        con su recibo, y las facturas de la suscripción en PDF.
      </p>

      <h2>Créditos de la API</h2>
      <ul>
        <li><strong>Recargar saldo</strong>: elige un pack (Starter, Plus o Power) y paga con una tarjeta guardada o una nueva. Si no marcas «guardar», la tarjeta se suelta al cerrar el cobro.</li>
        <li><strong>Recarga automática</strong>: cuando el saldo baja de $5 se cobra el pack elegido con la tarjeta elegida, sin que tengas que hacer nada. Si el cobro falla, la recarga se apaga y te avisamos por correo.</li>
        <li>Cada movimiento (recarga o consumo por petición, con modelo y tokens) queda en el historial de créditos.</li>
      </ul>

      <h2>Seguridad</h2>
      <p>
        Los campos de tarjeta son iframes servidos por Stripe: el número no toca el
        dominio ni los servidores de lixbon. Cada cobro se confirma por dos vías (la
        respuesta de Stripe y su webhook) y es idempotente, así que nunca se acredita ni
        se cobra dos veces.
      </p>

      <Callout>
        Las condiciones completas están en <a href="/legal/reembolsos">Cancelaciones y
        reembolsos</a> y en los <a href="/legal/terminos">Términos</a>.
      </Callout>
    </>
  );
}

function Privacidad() {
  return (
    <>
      <h1>Privacidad y datos</h1>
      <p className="docs__lead">
        Qué guarda lixbon, para qué, y cómo lo controlas desde{' '}
        <a href="/account/privacidad">Ajustes → Privacidad</a>.
      </p>

      <h2>Qué se guarda</h2>
      <ul>
        <li><strong>Cuenta</strong>: correo, nombre y contraseña (con hash).</li>
        <li><strong>Conversaciones y diseños</strong>, si el historial está activado, para que puedas retomarlos.</li>
        <li><strong>Uso</strong>: mensajes y tokens por día, para aplicar los límites del plan y mostrarte tu consumo.</li>
        <li><strong>Facturación</strong>: el identificador de cliente en Stripe, el plan y el saldo de créditos. Nunca el número de tu tarjeta.</li>
      </ul>

      <h2>Ajustes de privacidad</h2>
      <ul>
        <li><strong>Datos de uso anónimos</strong>: métricas agregadas para mejorar el servicio.</li>
        <li><strong>Historial de conversaciones</strong>: desactivado, los chats nuevos no se guardan (el uso sí se contabiliza).</li>
      </ul>

      <h2>Tus datos</h2>
      <ul>
        <li><strong>Exportar</strong>: descarga una copia de tus datos en JSON.</li>
        <li><strong>Borrar el historial</strong>: elimina todas las conversaciones; el uso agregado se conserva.</li>
        <li><strong>Eliminar la cuenta</strong>: borra la cuenta y todos sus datos. Pide tu contraseña; si tienes un plan de pago, la suscripción se cancela en Stripe en ese momento.</li>
      </ul>

      <h2>Enlaces públicos</h2>
      <p>
        Una conversación o un diseño solo es visible para otros si creas su enlace
        público; puedes dejar de compartirlo cuando quieras y el enlace deja de
        funcionar al instante.
      </p>

      <Callout>
        El texto completo está en la <a href="/legal/privacidad">Política de privacidad y
        tratamiento de datos</a>; las condiciones del servicio, en los{' '}
        <a href="/legal/terminos">Términos</a>.
      </Callout>
    </>
  );
}

const CUERPOS = {
  introduccion: Introduccion,
  'primeros-pasos': PrimerosPasos,
  chat: ChatWeb,
  visuals: Visuals,
  cli: Cli,
  desktop: Desktop,
  remote: Remote,
  api: ApiDocs,
  'usar-api-key': UsarApiKey,
  'precios-api': PreciosApi,
  planes: Planes,
  facturacion: Facturacion,
  privacidad: Privacidad,
};

export const SECTIONS = DOCS_INDEX.map((s) => ({ ...s, Body: CUERPOS[s.id] }));
