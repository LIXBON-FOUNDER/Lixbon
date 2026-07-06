// docsContent.jsx — contenido de lixbon Docs. Cada sección es un componente que
// recibe `base` (origen del gateway) para los ejemplos. El índice de la izquierda
// se genera desde SECTIONS.
import { CodeBlock } from '../components/CodeBlock';

export const SECTIONS = [
  {
    id: 'introduccion',
    group: 'Empezar',
    title: 'Introducción',
    Body: Introduccion,
  },
  {
    id: 'primeros-pasos',
    group: 'Empezar',
    title: 'Primeros pasos',
    Body: PrimerosPasos,
  },
  {
    id: 'cli',
    group: 'Aplicaciones',
    title: 'CLI',
    Body: Cli,
  },
  {
    id: 'desktop',
    group: 'Aplicaciones',
    title: 'App de escritorio',
    Body: Desktop,
  },
  {
    id: 'api',
    group: 'Desarrolladores',
    title: 'API',
    Body: ApiDocs,
  },
  {
    id: 'planes',
    group: 'Desarrolladores',
    title: 'Planes y límites',
    Body: Planes,
  },
];

function Introduccion() {
  return (
    <>
      <h1>¿Qué es lixbon?</h1>
      <p className="docs__lead">
        lixbon es una plataforma de chat con modelos de lenguaje que corre sobre un
        clúster de GPUs propio. Puedes usarla desde la web, desde tu terminal con el
        CLI, desde la app de escritorio o integrarla en tu código con una API
        compatible con OpenAI.
      </p>

      <h2>Cómo funciona</h2>
      <p>
        Tus mensajes llegan a un <strong>gateway</strong> que los enruta al mejor nodo
        GPU disponible del clúster y te devuelve la respuesta en streaming, token a
        token. No dependes de un proveedor externo: la inferencia ocurre en hardware
        propio, y el orquestador reparte la carga y evita los nodos caídos.
      </p>

      <h2>Formas de usar lixbon</h2>
      <ul>
        <li><strong>Chat web</strong> — la forma más rápida de empezar, sin instalar nada.</li>
        <li><strong>CLI</strong> — chatea desde la terminal, con modo agente y contexto de tu carpeta de trabajo.</li>
        <li><strong>App de escritorio</strong> — la experiencia completa como aplicación nativa.</li>
        <li><strong>API</strong> — integra los modelos en tus propias aplicaciones con endpoints compatibles con OpenAI.</li>
      </ul>

      <div className="docs__callout">
        ¿Listo para empezar? Continúa con <a href="/docs/primeros-pasos">Primeros pasos</a>.
      </div>
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
        Entra al <a href="/">chat</a> y regístrate con tu correo, nombre y una
        contraseña. Al registrarte recibes automáticamente el plan{' '}
        <strong>Gratuito</strong>, suficiente para probar la plataforma.
      </p>

      <h2>2. Escribe tu primer mensaje</h2>
      <p>
        Escribe en el cuadro de texto y pulsa Enter. La respuesta aparece en
        streaming. Cada conversación se guarda en tu historial y puedes retomarla,
        renombrarla o eliminarla cuando quieras.
      </p>

      <h2>3. Elige un modelo</h2>
      <p>
        En la cabecera del chat puedes cambiar de modelo. Los modelos disponibles
        dependen de tu plan: el plan Gratuito incluye los modelos pequeños, y los
        planes de pago habilitan todos los del clúster.
      </p>

      <h2>4. Lleva lixbon a tu terminal</h2>
      <p>
        Cuando quieras usarlo mientras programas, instala el{' '}
        <a href="/docs/cli">CLI</a> o la <a href="/docs/desktop">app de escritorio</a>.
      </p>
    </>
  );
}

function Cli({ base }) {
  return (
    <>
      <h1>CLI</h1>
      <p className="docs__lead">
        El CLI de lixbon te deja chatear con el clúster desde la terminal, con modo
        agente y contexto de tu carpeta de trabajo. Requiere Python 3.10 o superior.
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

      <h2>Configuración</h2>
      <p>
        La primera vez, ejecuta <code>setup</code> para guardar tu servidor y tu API
        key (la generas en <a href="/account">Mi cuenta</a>):
      </p>
      <CodeBlock code={`lixbon setup`} />

      <h2>Comandos principales</h2>
      <table className="docs__table">
        <thead><tr><th>Comando</th><th>Qué hace</th></tr></thead>
        <tbody>
          <tr><td><code>lixbon setup</code></td><td>Configuración inicial (servidor y API key)</td></tr>
          <tr><td><code>lixbon chat</code></td><td>Chat interactivo en la terminal</td></tr>
          <tr><td><code>lixbon status</code></td><td>Estado del gateway y del clúster</td></tr>
          <tr><td><code>lixbon update</code></td><td>Actualiza el CLI a la última versión</td></tr>
        </tbody>
      </table>

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
        La app de escritorio ofrece la experiencia completa de lixbon como aplicación
        nativa para Windows, con actualizaciones automáticas.
      </p>

      <h2>Instalación</h2>
      <p>
        Descarga el instalador desde la página de{' '}
        <a href="/aplicaciones">Aplicaciones</a> y ejecútalo. La app se actualiza sola
        cuando publicamos una versión nueva: te avisa y aplica la actualización
        firmada sin que tengas que reinstalar.
      </p>

      <h2>Canales de actualización</h2>
      <p>
        Hay dos canales: <strong>stable</strong> (recomendado) y{' '}
        <strong>beta</strong> (versiones nuevas antes de tiempo). La app en el canal
        estable solo recibe versiones estables.
      </p>

      <div className="docs__callout">
        Si aún no ves un instalador en Aplicaciones, es que todavía no se ha publicado
        una versión — mientras tanto puedes usar el <a href="/docs/cli">CLI</a> o el
        <a href="/"> chat web</a>.
      </div>
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
        Genera una API key en <a href="/account">Mi cuenta</a>. Se muestra una única
        vez al crearla — guárdala. Envíala en la cabecera <code>Authorization</code>:
      </p>
      <CodeBlock code={`Authorization: Bearer lixbon_sk_tu_clave`} />

      <h2>Endpoint base</h2>
      <CodeBlock code={`${base}/v1`} />

      <h2>Listar modelos</h2>
      <CodeBlock label="cURL" code={`curl ${base}/v1/models -H "Authorization: Bearer lixbon_sk_tu_clave"`} />

      <h2>Chat completions (streaming)</h2>
      <CodeBlock
        label="cURL"
        code={`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_tu_clave" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"Hola"}],"stream":true}'`}
      />
      <p>
        La respuesta llega como eventos <code>text/event-stream</code> en el mismo
        formato de OpenAI (<code>data: {'{...}'}</code> y <code>data: [DONE]</code> al
        final).
      </p>

      <h2>Con el SDK de OpenAI (Python)</h2>
      <CodeBlock
        label="Python"
        code={`from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="lixbon_sk_tu_clave")

stream = client.chat.completions.create(
    model="llama3.2",
    messages=[{"role": "user", "content": "Hola"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`}
      />

      <div className="docs__callout">
        El límite de solicitudes por minuto y los modelos disponibles dependen de tu
        plan. Consulta <a href="/docs/planes">Planes y límites</a>.
      </div>
    </>
  );
}

function Planes() {
  return (
    <>
      <h1>Planes y límites</h1>
      <p className="docs__lead">
        Cada cuenta tiene un plan que define cuántos mensajes y tokens puedes usar,
        cuántas API keys puedes tener y a qué modelos accedes.
      </p>

      <h2>Los tres planes</h2>
      <table className="docs__table">
        <thead>
          <tr><th>Plan</th><th>Mensajes/día</th><th>Tokens/mes</th><th>API keys</th><th>Modelos</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Gratuito</strong></td><td>30</td><td>150 000</td><td>1</td><td>Pequeños</td></tr>
          <tr><td><strong>Pro</strong></td><td>500</td><td>5 000 000</td><td>5</td><td>Todos</td></tr>
          <tr><td><strong>Advance</strong></td><td>Ilimitados</td><td>20 000 000</td><td>20</td><td>Todos</td></tr>
        </tbody>
      </table>
      <p>
        Consulta los precios actualizados y cambia de plan en la página de{' '}
        <a href="/planes">Planes</a>.
      </p>

      <h2>Cómo se cuentan los límites</h2>
      <ul>
        <li>Los <strong>mensajes por día</strong> se reinician cada día a medianoche (UTC).</li>
        <li>Los <strong>tokens por mes</strong> se reinician el día 1 de cada mes.</li>
        <li>Puedes ver tu consumo en tiempo real en <a href="/account">Mi cuenta</a>.</li>
      </ul>

      <h2>Cuándo chocas con un límite</h2>
      <p>
        Si superas tu cuota, la plataforma te lo dice con claridad e indica cuándo se
        reinicia. Para levantar el límite, mejora tu plan. Lo mismo aplica a la API:
        recibes un error <code>429</code> con el detalle de la cuota y el momento de
        reinicio.
      </p>
    </>
  );
}
