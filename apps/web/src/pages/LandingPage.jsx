// LandingPage.jsx — la portada pública de lixbon.com (/ sin sesión). Es la
// página que posiciona: texto real en HTML, un H1, secciones por producto,
// precios resumidos y preguntas frecuentes con su esquema FAQPage.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { IconArrowLeft, IconBolt, IconChat, IconCode, IconLayers, IconShield, IconTerminal } from '../components/Icons';
import { ORGANIZACION, SITE_URL, useSeo } from '../lib/seo';

const PRODUCTOS = [
  {
    Icon: IconChat, titulo: 'Chat', a: '/docs/chat',
    texto: 'Conversaciones con streaming, historial, adjuntos (PDF, imágenes, código), dictado y búsqueda en internet. Los modelos que razonan enseñan su pensamiento.',
  },
  {
    Icon: IconLayers, titulo: 'Visuals', a: '/docs/visuals',
    texto: 'Describe una landing, un dashboard, un email o un prototipo y el modelo lo construye en HTML. Lo afinas hablando o tocando cada elemento, lo compartes por enlace y lo conviertes en un proyecto React.',
  },
  {
    Icon: IconTerminal, titulo: 'CLI y app de escritorio', a: '/docs/cli',
    texto: 'Un agente que lee y edita tu proyecto, ejecuta comandos y hace commits, con aprobación paso a paso. Modo plan para explorar sin tocar nada, y Remote para dirigirlo desde el móvil.',
  },
  {
    Icon: IconCode, titulo: 'API compatible con OpenAI', a: '/docs/api',
    texto: 'Cambia la URL base y la clave en el SDK que ya usas. Se paga por tokens con créditos prepago, sin suscripción, y con las tarifas publicadas.',
  },
];

const PLANES = [
  { nombre: 'Gratuito', precio: '$0', detalle: '30 mensajes al día · 150 000 tokens al mes · 1 API key' },
  { nombre: 'Pro', precio: '$9.90', detalle: '500 mensajes al día · 5 millones de tokens · 5 API keys', destacado: true },
  { nombre: 'Advance', precio: '$24.90', detalle: 'Mensajes ilimitados · 20 millones de tokens · 20 API keys' },
];

const FAQ = [
  ['¿Qué modelos usa lixbon?', 'Modelos abiertos como Qwen 3.5, DeepSeek-R1 y gpt-oss, que corren en GPUs propias o alquiladas. El catálogo cambia según lo que haya instalado; lo ves en el selector del chat y en GET /v1/models.'],
  ['¿Mis conversaciones se usan para entrenar modelos?', 'No. Se guardan solo para que puedas retomarlas, y puedes desactivar el historial, exportar tus datos o borrarlo todo desde Ajustes → Privacidad.'],
  ['¿Funciona con el SDK de OpenAI?', 'Sí. La API acepta el mismo formato de chat completions, con streaming. Solo cambias base_url por https://lixbon.com/v1 y api_key por tu clave lixbon_sk_.'],
  ['¿Cuánto cuesta la API?', 'Se paga por tokens con créditos prepago que no caducan, según la tarifa de cada modelo (por ejemplo, Lixbon 1 a $0.40 por millón de tokens de entrada y $1.20 de salida). Un modelo sin tarifa publicada no se cobra.'],
  ['¿Puedo cancelar cuando quiera?', 'Sí, desde Ajustes → Facturación, con un clic. El plan sigue activo hasta el final del mes pagado y no se vuelve a cobrar.'],
  ['¿Necesito instalar algo?', 'Para el chat y Visuals, no: funcionan en el navegador. El CLI se instala con un comando en Windows, Linux y macOS, y la app de escritorio tiene instalador para Windows.'],
];

export default function LandingPage() {
  const jsonLd = useMemo(() => [
    ORGANIZACION,
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'lixbon',
      url: SITE_URL,
      inLanguage: 'es',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ.map(([q, a]) => ({
        '@type': 'Question', name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    },
  ], []);

  useSeo({
    title: 'Inteligencia artificial en GPUs propias: chat, agente de código y API',
    description: 'Chat con modelos abiertos, Visuals para diseñar webs, un agente de código en la terminal y una API compatible con OpenAI. Todo corre en GPUs propias: tus datos no salen a ningún proveedor.',
    path: '/',
    jsonLd,
  });

  return (
    <div className="page landing">
      <PublicNav />

      <main className="landing__main">
        <section className="landing__hero">
          <span className="landing__eyebrow">Modelos abiertos · GPUs propias · desde Medellín</span>
          <h1 className="landing__h1">
            Inteligencia artificial que corre en nuestras GPUs, <em>no en las de un proveedor</em>.
          </h1>
          <p className="landing__lead">
            Chatea, diseña webs, programa con un agente en tu terminal e integra los mismos
            modelos en tu código con una API compatible con OpenAI. Sin que tus datos
            salgan a terceros y sin sorpresas en la factura.
          </p>
          <div className="landing__cta">
            <Link to="/auth?mode=register" className="pill-btn pill-btn--primary landing__btn">Empezar gratis</Link>
            <Link to="/chat" className="pill-btn pill-btn--outline landing__btn">Probar el chat sin cuenta</Link>
          </div>
          <p className="landing__nota">Plan Gratuito con 30 mensajes al día. Sin tarjeta.</p>
        </section>

        <section className="landing__seccion" aria-labelledby="por-que">
          <h2 id="por-que" className="landing__h2">Por qué en GPUs propias</h2>
          <div className="landing__razones">
            <div className="landing__razon">
              <IconShield size={20} />
              <h3>Tus datos se quedan aquí</h3>
              <p>Los modelos corren en servidores que controlamos. Lo que escribes no se envía a OpenAI, Google ni Anthropic, y nunca se usa para entrenar.</p>
            </div>
            <div className="landing__razon">
              <IconBolt size={20} />
              <h3>Modelos abiertos, elegidos por tarea</h3>
              <p>Qwen 3.5, DeepSeek-R1, gpt-oss. Cada trabajo (chat, visión, autocompletado, embeddings) lo atiende el modelo que mejor lo hace.</p>
            </div>
            <div className="landing__razon">
              <IconCode size={20} />
              <h3>Precio que entiendes</h3>
              <p>Planes mensuales con límites claros, y una API que se paga por tokens con tarifas publicadas. Cancelas cuando quieras.</p>
            </div>
          </div>
        </section>

        <section className="landing__seccion" aria-labelledby="productos">
          <h2 id="productos" className="landing__h2">Una cuenta, cuatro formas de usarla</h2>
          <div className="landing__productos">
            {PRODUCTOS.map(({ Icon, titulo, texto, a }) => (
              <article key={titulo} className="landing__producto">
                <span className="landing__producto-icono"><Icon size={18} /></span>
                <h3>{titulo}</h3>
                <p>{texto}</p>
                <Link to={a} className="landing__mas">Cómo funciona <IconArrowLeft size={14} style={{ transform: 'rotate(180deg)' }} /></Link>
              </article>
            ))}
          </div>
        </section>

        <section className="landing__seccion" aria-labelledby="api">
          <div className="landing__api">
            <div>
              <h2 id="api" className="landing__h2">Si ya usas el SDK de OpenAI, ya sabes usar lixbon</h2>
              <p className="landing__parrafo">
                Cambia dos valores y tu código funciona contra nuestros modelos. Streaming,
                <code> usage</code> con los tokens reales y los mismos errores que conoces.
              </p>
              <Link to="/docs/usar-api-key" className="landing__mas">Recetas para Python, JavaScript y continue.dev</Link>
            </div>
            <pre className="landing__codigo"><code>{`from openai import OpenAI

client = OpenAI(
    base_url="https://lixbon.com/v1",
    api_key="lixbon_sk_tu_clave",
)

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[{"role": "user", "content": "Hola"}],
)
print(resp.choices[0].message.content)`}</code></pre>
          </div>
        </section>

        <section className="landing__seccion" aria-labelledby="precios">
          <h2 id="precios" className="landing__h2">Precios</h2>
          <div className="landing__planes">
            {PLANES.map((p) => (
              <article key={p.nombre} className={`landing__plan ${p.destacado ? 'is-destacado' : ''}`}>
                <h3>{p.nombre}</h3>
                <p className="landing__precio">{p.precio}<span> / mes</span></p>
                <p className="landing__plan-detalle">{p.detalle}</p>
              </article>
            ))}
          </div>
          <p className="landing__nota">
            Todos los planes acceden a todos los modelos. La API se paga aparte, por tokens.{' '}
            <Link to="/planes">Ver los planes</Link> · <Link to="/docs/precios-api">Precios de la API</Link>
          </p>
        </section>

        <section className="landing__seccion" aria-labelledby="faq">
          <h2 id="faq" className="landing__h2">Preguntas frecuentes</h2>
          <div className="landing__faq">
            {FAQ.map(([q, a]) => (
              <details key={q} className="landing__pregunta">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing__final">
          <h2 className="landing__h2">Empieza con el plan Gratuito</h2>
          <p className="landing__parrafo">Treinta mensajes al día para probar el chat, Visuals y el CLI. Sin tarjeta.</p>
          <Link to="/auth?mode=register" className="pill-btn pill-btn--primary landing__btn">Crear cuenta</Link>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

