// docsContent.jsx — contenido de lixbon Docs. Cada sección es un componente que
// recibe `base` (origen del gateway) para los ejemplos. El índice de la izquierda
// se genera desde SECTIONS.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CodeBlock } from '../components/CodeBlock';
import { IconShield } from '../components/Icons';

// Aviso dentro de la prosa: tinte de acento y su icono, sin marco.
function Callout({ children }) {
  return (
    <Callout>
      <IconShield size={17} />
      <p>{children}</p>
    </Callout>
  );
}

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
    id: 'usar-api-key',
    group: 'Desarrolladores',
    title: 'Usar tu API key',
    Body: UsarApiKey,
  },
  {
    id: 'precios-api',
    group: 'Desarrolladores',
    title: 'Precios de la API',
    Body: PreciosApi,
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

      <h2>Primer uso</h2>
      <p>
        Ejecuta <code>lixbon</code> y listo: la primera vez se abre el inicio de
        sesión interactivo — con tu correo y contraseña, o pegando una API key{' '}
        <code>lixbon_sk_…</code> (la generas en <a href="/account">Mi cuenta</a>).
        Después eliges el modelo con las flechas del teclado y ya estás chateando.
      </p>
      <CodeBlock code={`lixbon`} />
      <p>
        Dentro del chat, escribe <code>/</code> para ver todos los comandos
        (cambiar de modelo o modo, adjuntar imágenes con <code>@ruta.png</code>,
        compactar la conversación con <code>/compact</code>, etc.).
      </p>

      <h2>Comandos principales</h2>
      <table className="docs__table">
        <thead><tr><th>Comando</th><th>Qué hace</th></tr></thead>
        <tbody>
          <tr><td><code>lixbon</code></td><td>Abre el chat (con login integrado la primera vez)</td></tr>
          <tr><td><code>lixbon setup</code></td><td>Volver a iniciar sesión (correo o API key)</td></tr>
          <tr><td><code>lixbon models</code></td><td>Listar los modelos disponibles</td></tr>
          <tr><td><code>lixbon status</code></td><td>Ver la configuración local del CLI</td></tr>
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

      <Callout>
        Si aún no ves un instalador en Aplicaciones, es que todavía no se ha publicado
        una versión — mientras tanto puedes usar el <a href="/docs/cli">CLI</a> o el
        <a href="/"> chat web</a>.
      </Callout>
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

      <Callout>
        El uso de la API se paga con <strong>créditos prepago</strong> según los tokens
        que consumas — consulta <a href="/docs/precios-api">Precios de la API</a> y las
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
        «Nueva key». Se muestra <strong>una sola vez</strong> — guárdala en un gestor de
        secretos. Si la pierdes, desactívala y crea otra. Opcionalmente una key puede
        restringirse a un único modelo.
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
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"Hola"}]}'`}
      />

      <h2>Python (SDK de OpenAI)</h2>
      <CodeBlock
        label="Python"
        code={`from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="lixbon_sk_tu_clave")

resp = client.chat.completions.create(
    model="llama3.2",
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
  model: "llama3.2",
  messages: [{ role: "user", content: "Hola" }],
});
console.log(resp.choices[0].message.content);`}
      />

      <h2>IDE lixbon</h2>
      <p>
        En la <a href="/aplicaciones">app de escritorio</a> no necesitas pegar nada:
        inicia sesión con tu correo y la app crea y gestiona su propia key
        («lixbon Desktop»). También puedes entrar pegando una key existente.
      </p>

      <h2>continue.dev (VS Code / JetBrains)</h2>
      <CodeBlock
        label="config.yaml"
        code={`models:
  - name: lixbon
    provider: openai
    model: llama3.2
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
        Precios en USD por <strong>millón de tokens</strong>. La tarifa se elige por el
        prefijo del id del modelo; si ninguno coincide aplica la tarifa estándar (<code>*</code>).
      </p>
      {error && (
        <p>No se pudieron cargar las tarifas ahora mismo. Intenta de nuevo en unos minutos.</p>
      )}
      {pricing === null && !error && <p>Cargando tarifas…</p>}
      {pricing && (
        <table className="docs__table">
          <thead>
            <tr><th>Modelo</th><th>Entrada ($/Mtok)</th><th>Salida ($/Mtok)</th></tr>
          </thead>
          <tbody>
            {pricing.map((p) => (
              <tr key={p.model_prefix}>
                <td>
                  {p.display_name ? <> — {p.display_name}</> : p.model_prefix}
                </td>
                <td>{fmt(p.input_usd_per_mtok)}</td>
                <td>{fmt(p.output_usd_per_mtok)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Cómo se calcula el costo</h2>
      <p>
        Cada respuesta de la API incluye <code>usage</code> con los tokens de entrada
        (<code>prompt_tokens</code>) y salida (<code>completion_tokens</code>). El costo es:
      </p>
      <CodeBlock code={`costo = prompt_tokens × tarifa_entrada / 1 000 000
      + completion_tokens × tarifa_salida / 1 000 000`} />
      <p>
        Ejemplo con la tarifa estándar ($0.20 entrada / $0.60 salida): una petición con
        1 000 tokens de entrada y 2 000 de salida cuesta $0.0014.
      </p>

      <h2>Recargas</h2>
      <ul>
        <li>Compra packs de créditos en <a href="/account/facturacion">Ajustes → Facturación</a> (pago único con tarjeta).</li>
        <li>Los créditos <strong>no caducan</strong> y solo se descuentan por uso real de la API.</li>
        <li>El chat de la web y de la app con tu sesión <strong>no</strong> consume créditos: va con tu plan.</li>
      </ul>

      <h2>Sin saldo</h2>
      <p>
        Cuando el saldo llega a cero, la API responde <code>402</code> con
        <code> insufficient_credits</code> y tu saldo actual. Recarga y la key vuelve a
        funcionar al instante — las keys nunca se bloquean por otra razón de pago.
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
        reinicia. Para levantar el límite, mejora tu plan.
      </p>

      <h2>¿Y la API?</h2>
      <p>
        Las peticiones con API key <strong>no</strong> consumen la cuota del plan: se pagan
        con <a href="/docs/precios-api">créditos prepago</a> por tokens y pueden usar
        cualquier modelo del clúster. Del plan solo se conserva el límite de
        solicitudes por minuto.
      </p>
    </>
  );
}
