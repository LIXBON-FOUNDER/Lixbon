// guiasContent.jsx — artículos de /guias. Cada uno responde a una búsqueda
// concreta y solo cuenta lo que lixbon hace de verdad.
import { Link } from 'react-router-dom';
import { CodeBlock } from '../components/CodeBlock';
import { GUIAS_INDEX } from './guiasIndex';

const BASE = 'https://lixbon.com';

function ApiCompatible() {
  return (
    <>
      <p className="docs__lead">
        Casi todas las herramientas de IA (SDKs, editores, agentes, LangChain, Open WebUI)
        hablan el «dialecto» de la API de OpenAI. Que lixbon sea compatible significa que
        no tienes que aprender otro: cambias dos valores y tu código habla con nuestros
        modelos.
      </p>

      <h2>Qué significa «compatible con OpenAI»</h2>
      <p>
        Que aceptamos las mismas rutas (<code>/v1/models</code>, <code>/v1/chat/completions</code>),
        el mismo formato de mensajes (<code>role</code> y <code>content</code>), el mismo
        streaming por eventos y el mismo campo <code>usage</code> con los tokens consumidos.
        Cualquier cliente que te deje configurar una «base URL» y una «API key» sirve.
      </p>

      <h2>1. Consigue tu clave</h2>
      <p>
        Crea una cuenta, ve a <Link to="/account/cuenta">Ajustes → Cuenta → API keys</Link> y
        pulsa «Nueva key». Empieza por <code>lixbon_sk_</code> y solo se muestra una vez.
        Recarga unos créditos en <Link to="/account/facturacion">Facturación</Link>: la API se
        paga por tokens, no por suscripción (el pack más pequeño son $5).
      </p>

      <h2>2. Los dos valores</h2>
      <table className="docs__table">
        <thead><tr><th>Parámetro</th><th>Valor</th></tr></thead>
        <tbody>
          <tr><td>Base URL</td><td><code>{BASE}/v1</code></td></tr>
          <tr><td>API key</td><td><code>lixbon_sk_tu_clave</code></td></tr>
        </tbody>
      </table>

      <h2>3. Primera llamada con cURL</h2>
      <CodeBlock label="cURL" code={`curl ${BASE}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_tu_clave" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"lixbon-1","messages":[{"role":"user","content":"Explícame qué es un token en dos frases"}]}'`} />
      <p>
        <code>model</code> es opcional: sin él usamos el modelo de chat por defecto. Con{' '}
        <code>GET /v1/models</code> ves los disponibles; <code>lixbon-1</code> es Qwen 3.5 27B.
      </p>

      <h2>4. Python</h2>
      <CodeBlock label="Python" code={`pip install openai

from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key="lixbon_sk_tu_clave")

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[
        {"role": "system", "content": "Responde en español, breve."},
        {"role": "user", "content": "¿Qué es un embedding?"},
    ],
)
print(resp.choices[0].message.content)
print(resp.usage.prompt_tokens, resp.usage.completion_tokens)`} />

      <h2>5. JavaScript</h2>
      <CodeBlock label="JavaScript" code={`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${BASE}/v1", apiKey: "lixbon_sk_tu_clave" });

const stream = await client.chat.completions.create({
  model: "lixbon-1",
  messages: [{ role: "user", content: "Dame tres nombres para una cafetería" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`} />

      <h2>6. Errores que vas a ver (y qué hacer)</h2>
      <table className="docs__table">
        <thead><tr><th>Código</th><th>Qué pasa</th><th>Solución</th></tr></thead>
        <tbody>
          <tr><td><code>401</code></td><td>Clave ausente o revocada</td><td>Genera otra en Ajustes</td></tr>
          <tr><td><code>402 insufficient_credits</code></td><td>Sin saldo</td><td>Recarga en Facturación</td></tr>
          <tr><td><code>403 model_not_priced</code></td><td>Ese modelo no tiene tarifa publicada</td><td>Usa uno de <Link to="/docs/precios-api">la tabla</Link></td></tr>
          <tr><td><code>429</code></td><td>Demasiadas peticiones por minuto</td><td>Espera o sube de plan</td></tr>
          <tr><td><code>503 model_not_available</code></td><td>Ningún nodo sirve ese modelo ahora</td><td>Prueba otro de <code>/v1/models</code></td></tr>
        </tbody>
      </table>

      <h2>7. Cuánto cuesta</h2>
      <p>
        Cada respuesta trae <code>usage</code>. Con Lixbon 1 ($0.40 por millón de tokens de
        entrada y $1.20 de salida), una llamada de 500 tokens de entrada y 300 de salida cuesta
        $0.00056. Con $5 de créditos haces unas nueve mil llamadas así. Los precios de todos
        los modelos están en <Link to="/docs/precios-api">Precios de la API</Link>, y tu consumo
        diario en <Link to="/account/uso">Ajustes → Uso</Link>.
      </p>
    </>
  );
}

function QwenPython() {
  return (
    <>
      <p className="docs__lead">
        Qwen 3.5 es uno de los mejores modelos abiertos para español y para código. En lixbon
        lo tienes como <code>lixbon-1</code> (la versión de 27 mil millones de parámetros) sin
        instalar nada: se llama desde Python igual que a cualquier API de OpenAI.
      </p>

      <h2>Preparación</h2>
      <CodeBlock label="Terminal" code={`pip install openai
export LIXBON_API_KEY=lixbon_sk_tu_clave   # en Windows: set LIXBON_API_KEY=...`} />
      <p>
        La clave la creas en <Link to="/account/cuenta">Ajustes → Cuenta</Link>; los créditos,
        en <Link to="/account/facturacion">Facturación</Link>.
      </p>

      <h2>Llamada básica</h2>
      <CodeBlock label="Python" code={`import os
from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key=os.environ["LIXBON_API_KEY"])

def preguntar(texto):
    resp = client.chat.completions.create(
        model="lixbon-1",
        messages=[{"role": "user", "content": texto}],
    )
    return resp.choices[0].message.content

print(preguntar("Resume en una frase qué hace la librería requests"))`} />

      <h2>Un prompt de sistema que se note</h2>
      <p>
        Qwen obedece bien las instrucciones de sistema. Úsalas para fijar idioma, tono y
        formato en vez de repetirlo en cada mensaje:
      </p>
      <CodeBlock label="Python" code={`SISTEMA = (
    "Eres un asistente técnico. Respondes en español, sin rodeos, "
    "con ejemplos de código cuando ayuden. Si no sabes algo, lo dices."
)

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[
        {"role": "system", "content": SISTEMA},
        {"role": "user", "content": "¿Cómo leo un CSV grande sin cargarlo entero en memoria?"},
    ],
    temperature=0.3,
)`} />

      <h2>Streaming (para que el usuario no espere)</h2>
      <CodeBlock label="Python" code={`stream = client.chat.completions.create(
    model="lixbon-1",
    messages=[{"role": "user", "content": "Escribe un haiku sobre Medellín"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`} />

      <h2>Respuestas en JSON</h2>
      <p>
        Pide el formato en el prompt y valida con <code>json.loads</code>; Qwen 3.5 lo respeta
        con mucha fiabilidad si le das un ejemplo:
      </p>
      <CodeBlock label="Python" code={`import json

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[
        {"role": "system", "content": 'Responde SOLO con JSON: {"sentimiento": "positivo|neutro|negativo", "motivo": "..."}'},
        {"role": "user", "content": "El envío llegó tarde pero el producto es excelente."},
    ],
    temperature=0,
)
datos = json.loads(resp.choices[0].message.content)
print(datos["sentimiento"])`} />

      <h2>Cuánto cuesta cada llamada</h2>
      <p>
        <code>resp.usage</code> trae los tokens reales. Con la tarifa de Lixbon 1:
      </p>
      <CodeBlock label="Python" code={`ENTRADA, SALIDA = 0.40, 1.20   # USD por millón de tokens
u = resp.usage
costo = (u.prompt_tokens * ENTRADA + u.completion_tokens * SALIDA) / 1_000_000
print(f"{costo:.6f} USD")   # una respuesta normal ronda las 5 diezmilésimas`} />

      <h2>Cuándo usar otro modelo</h2>
      <ul>
        <li>Para tareas simples y muy repetidas (clasificar, extraer campos), un modelo pequeño como <code>qwen3:4b</code> cuesta cinco veces menos.</li>
        <li>Para razonamiento largo o depuración difícil, mira si hay un modelo grande activo en <code>/v1/models</code> (por ejemplo Qwen 3.5 122B o gpt-oss 120B).</li>
        <li>Las tarifas vigentes están siempre en <Link to="/docs/precios-api">Precios de la API</Link>.</li>
      </ul>
    </>
  );
}

function AgenteTerminal() {
  return (
    <>
      <p className="docs__lead">
        El CLI de lixbon no es solo un chat en la terminal: en modo agente, el modelo lee
        tu proyecto, propone cambios, los aplica con tu permiso, ejecuta las pruebas y hace
        el commit. Esta guía te lleva de cero a un primer cambio revisado.
      </p>

      <h2>1. Instala el CLI</h2>
      <CodeBlock label="PowerShell (Windows)" code={`irm ${BASE}/install.ps1 | iex`} />
      <CodeBlock label="bash (Linux y macOS)" code={`curl -fsSL ${BASE}/install.sh | bash`} />
      <p>
        Abre una terminal nueva, ejecuta <code>lixbon</code> y entra con tu correo y contraseña
        (o con una API key). Necesitas Python 3.10 o superior.
      </p>

      <h2>2. Colócate en tu proyecto</h2>
      <p>
        El agente trabaja sobre la carpeta de trabajo. Abre el CLI dentro del proyecto o
        fíjala con <code>/workspace ruta</code>. Con <code>/init</code> el modelo genera un{' '}
        <code>LIXBON.md</code> con el contexto del proyecto (stack, cómo se ejecuta, cómo se
        prueba) que se incluye en cada turno.
      </p>

      <h2>3. Empieza en modo plan</h2>
      <CodeBlock label="lixbon" code={`/mode agent
/plan on
Quiero añadir paginación al endpoint /api/pedidos. Revisa cómo está hecho y propón un plan.`} />
      <p>
        En modo plan el agente solo lee y propone: nada se toca. Es la forma segura de
        conocer un código nuevo o de validar un enfoque antes de gastar tokens editando.
      </p>

      <h2>4. Deja que edite, con aprobación</h2>
      <CodeBlock label="lixbon" code={`/plan off
Aplica el plan.`} />
      <p>
        Cada edición aparece como un diff (<code>● Update(archivo) +N -M</code>) y te pide
        aprobarla: <strong>Sí</strong>, <strong>Sí y no preguntar más</strong> o <strong>No</strong>.
        Las herramientas de solo lectura no preguntan. Si te arrepientes de un turno entero,{' '}
        <code>/undo</code> revierte lo que tocó.
      </p>

      <h2>5. Pruebas sin fricción</h2>
      <CodeBlock label="lixbon" code={`/allow pytest
/allow npm test
/check on`} />
      <p>
        <code>/allow</code> deja que el agente ejecute esos comandos sin preguntar cada vez;{' '}
        <code>/check on</code> pasa el linter por cada archivo que edita y le devuelve los
        errores para que los corrija él mismo. Con <code>/run comando</code> le das la salida de
        cualquier comando como contexto.
      </p>

      <h2>6. Revisa y haz commit</h2>
      <CodeBlock label="lixbon" code={`/diff
/commit`} />
      <p>
        <code>/diff</code> muestra los cambios sin confirmar; <code>/commit</code> redacta el
        mensaje a partir de ellos y confirma. Si prefieres tu propio mensaje:{' '}
        <code>/commit "feat: paginación en /api/pedidos"</code>.
      </p>

      <h2>Consejos que ahorran tokens y sustos</h2>
      <ul>
        <li>Pide una cosa por turno. «Añade paginación» va mejor que «añade paginación, cambia el logger y actualiza el README».</li>
        <li>Cuando el contexto crece, <code>/compact</code> lo resume y sigue con la memoria justa; <code>/cost</code> te dice cuánto llevas.</li>
        <li>En agente y plan el CLI pide razonamiento alto a los modelos que lo admiten: piensan más y se equivocan menos al editar.</li>
        <li>¿Tienes que salir? <code>/remote</code> te da un enlace y un QR para seguir la sesión y aprobar cambios desde el móvil.</li>
        <li>Si diseñaste algo en <Link to="/docs/visuals">Visuals</Link>, <code>/visual &lt;id&gt; react api</code> lo convierte en un proyecto React + Vite con API.</li>
      </ul>
      <p>
        La lista completa de comandos está en la <Link to="/docs/cli">documentación del CLI</Link>.
      </p>
    </>
  );
}

function DatosPrivados() {
  return (
    <>
      <p className="docs__lead">
        Cuando escribes en un chat de IA, tu texto viaja a los servidores de alguien. La
        pregunta útil no es «¿es seguro?» sino «¿a dónde va, quién lo guarda y para qué?».
        Esta guía responde a eso para lixbon, sin adornos.
      </p>

      <h2>A dónde va lo que escribes</h2>
      <p>
        En lixbon, tu mensaje llega a nuestro servidor y de ahí a una GPU que controlamos
        (propia o alquilada por horas). El modelo genera la respuesta y la GPU no conserva
        nada. No hay un tercer proveedor de IA en medio: no se llama a OpenAI, Google ni
        Anthropic.
      </p>

      <h2>Qué se guarda y qué no</h2>
      <ul>
        <li><strong>Se guarda</strong> tu conversación, si tienes activado el historial, para que puedas retomarla. Y cuánto usas (mensajes y tokens), para aplicar los límites del plan.</li>
        <li><strong>No se guarda</strong> nada en los nodos GPU, ni se usa tu contenido para entrenar modelos, ni se comparte con fines comerciales.</li>
        <li>Si desactivas «Historial de conversaciones» en <Link to="/account/privacidad">Ajustes → Privacidad</Link>, los chats nuevos no se guardan; el uso sí se cuenta.</li>
      </ul>

      <h2>Qué controles tienes</h2>
      <ul>
        <li><strong>Exportar</strong> todos tus datos en JSON, en un clic.</li>
        <li><strong>Borrar el historial</strong> completo cuando quieras.</li>
        <li><strong>Eliminar la cuenta</strong>: se borra todo lo tuyo y se cancela la suscripción en el acto.</li>
        <li><strong>Enlaces públicos</strong>: una conversación o un diseño solo es visible para otros si tú creas el enlace, y lo desactivas al instante.</li>
      </ul>

      <h2>Qué cambia frente a un servicio como ChatGPT</h2>
      <table className="docs__table">
        <thead><tr><th></th><th>Servicio de un gran proveedor</th><th>lixbon</th></tr></thead>
        <tbody>
          <tr><td>Dónde corre el modelo</td><td>En la nube del proveedor</td><td>En GPUs que controlamos</td></tr>
          <tr><td>Modelos</td><td>Cerrados, del proveedor</td><td>Abiertos (Qwen, DeepSeek, gpt-oss)</td></tr>
          <tr><td>Uso para entrenar</td><td>Depende del plan y de la configuración</td><td>Nunca</td></tr>
          <tr><td>Historial</td><td>Configurable</td><td>Configurable, exportable y borrable</td></tr>
          <tr><td>Precio de la API</td><td>Por tokens, tarifas del proveedor</td><td>Por tokens, tarifas publicadas y créditos que no caducan</td></tr>
        </tbody>
      </table>
      <p>
        Lo que no vas a encontrar aquí es el modelo más grande del mundo: usamos modelos
        abiertos que caben en GPUs reales. Para la mayoría de tareas (escribir, resumir,
        programar, diseñar) la diferencia es pequeña; para las que necesitan razonamiento
        muy largo, elige el modelo grande cuando esté activo.
      </p>

      <h2>Para empresas y datos sensibles</h2>
      <p>
        Si tu caso exige que los datos no salgan de tu infraestructura, escríbenos a{' '}
        <a href="mailto:soporte@lixbon.com">soporte@lixbon.com</a>: la arquitectura de
        lixbon (gateway + nodos GPU) permite desplegar los nodos en tu propio hardware.
      </p>
      <p>
        Los detalles legales están en la <Link to="/legal/privacidad">Política de privacidad</Link>.
      </p>
    </>
  );
}

const CUERPOS = {
  'api-compatible-openai-espanol': ApiCompatible,
  'usar-qwen-3-5-desde-python': QwenPython,
  'agente-de-codigo-en-la-terminal': AgenteTerminal,
  'ia-con-datos-privados-gpus-propias': DatosPrivados,
};

export const GUIAS = GUIAS_INDEX.map((g) => ({ ...g, Body: CUERPOS[g.id] }));
