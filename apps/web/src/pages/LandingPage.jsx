// LandingPage.jsx — la portada pública de lixbon.com (/). Minimalista: una
// columna, titulares grandes, secciones numeradas y dos dibujos de línea. Es
// la página que posiciona: todo el texto va en HTML, con FAQPage.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PublicNav } from '../components/PublicNav';
import { Logo } from '../components/Logo';
import { IconArrowLeft } from '../components/Icons';
import { IlustracionCluster, IlustracionPrivacidad } from '../components/IlustracionesLanding';
import { ORGANIZACION, SITE_URL, useSeo } from '../lib/seo';
import { useAuth } from '../hooks/useAuth';

const PRODUCTOS = [
  ['Chat', 'Conversaciones con streaming, historial, adjuntos (PDF, imágenes, código), dictado y búsqueda en internet. Los modelos que razonan enseñan su pensamiento.', '/docs/chat'],
  ['Visuals', 'Describe una landing, un dashboard, un email o un prototipo y el modelo lo construye en HTML. Lo afinas hablando o tocando cada elemento, lo compartes por enlace y lo conviertes en un proyecto React.', '/docs/visuals'],
  ['CLI y app de escritorio', 'Un agente que lee y edita tu proyecto, ejecuta comandos y hace commits, con aprobación paso a paso. Modo plan para explorar sin tocar nada, y Remote para dirigirlo desde el móvil.', '/docs/cli'],
  ['API compatible con OpenAI', 'Cambia la URL base y la clave en el SDK que ya usas. Se paga por tokens con créditos prepago, sin suscripción, y con las tarifas publicadas.', '/docs/api'],
];

const PLANES = [
  ['Gratuito', '$0', null, ['30 mensajes al día', '150 000 tokens al mes', '1 API key']],
  ['Pro', '$9.90', '/ mes', ['500 mensajes al día', '5 millones de tokens al mes', '5 API keys']],
  ['Advance', '$24.90', '/ mes', ['Mensajes ilimitados', '20 millones de tokens al mes', '20 API keys']],
];

const FAQ = [
  ['¿Qué modelos usa lixbon?', 'Modelos abiertos como Qwen 3.5, DeepSeek-R1 y gpt-oss, que corren en GPUs propias o alquiladas. El catálogo cambia según lo que haya instalado; lo ves en el selector del chat y en GET /v1/models.'],
  ['¿Mis conversaciones se usan para entrenar modelos?', 'No. Se guardan solo para que puedas retomarlas, y puedes desactivar el historial, exportar tus datos o borrarlo todo desde Ajustes → Privacidad.'],
  ['¿Funciona con el SDK de OpenAI?', 'Sí. La API acepta el mismo formato de chat completions, con streaming. Solo cambias base_url por https://lixbon.com/v1 y api_key por tu clave lixbon_sk_.'],
  ['¿Cuánto cuesta la API?', 'Se paga por tokens con créditos prepago que no caducan, según la tarifa de cada modelo (por ejemplo, Lixbon 1 a $0.40 por millón de tokens de entrada y $1.20 de salida). Un modelo sin tarifa publicada no se cobra.'],
  ['¿Puedo cancelar cuando quiera?', 'Sí, desde Ajustes → Facturación, con un clic. El plan sigue activo hasta el final del mes pagado y no se vuelve a cobrar.'],
  ['¿Necesito instalar algo?', 'Para el chat y Visuals, no: funcionan en el navegador. El CLI se instala con un comando en Windows, Linux y macOS, y la app de escritorio tiene instalador para Windows.'],
];

const CODIGO = `from openai import OpenAI

client = OpenAI(
    base_url="https://lixbon.com/v1",
    api_key="lixbon_sk_tu_clave",
)

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[{"role": "user", "content": "Hola"}],
)
print(resp.choices[0].message.content)`;

const Flecha = () => <IconArrowLeft size={15} style={{ transform: 'rotate(180deg)' }} />;

export default function LandingPage() {
  const { user } = useAuth();

  const jsonLd = useMemo(() => [
    ORGANIZACION,
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'lixbon', url: SITE_URL, inLanguage: 'es' },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
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

      <main className="landing__wrap">
        <section className="landing__hero">
          <h1 className="landing__h1">Inteligencia artificial que corre en nuestras GPUs, no en las de un proveedor.</h1>
          <p className="landing__lead">
            Chatea, diseña webs, programa con un agente en tu terminal e integra los mismos modelos en
            tu código con una API compatible con OpenAI. Tus datos no salen a terceros y la factura no
            trae sorpresas.
          </p>
          <div className="landing__cta">
            {user ? (
              <Link to="/chat" className="pill-btn pill-btn--primary landing__btn">Ir al chat</Link>
            ) : (
              <>
                <Link to="/auth?mode=register" className="pill-btn pill-btn--primary landing__btn">Empezar gratis</Link>
                <Link to="/chat" className="landing__enlace">Probar el chat sin cuenta <Flecha /></Link>
              </>
            )}
          </div>
          {!user && <p className="landing__nota">Plan Gratuito con 30 mensajes al día. Sin tarjeta.</p>}
        </section>

        <section className="landing__banda"><IlustracionCluster /></section>

        <section className="landing__fila">
          <div>
            <span className="landing__num">01 — Por qué en GPUs propias</span>
            <h2 className="landing__h2">Tus datos se quedan aquí.</h2>
            <p className="landing__p">Los modelos corren en servidores que controlamos. Lo que escribes no se envía a OpenAI, Google ni Anthropic, y nunca se usa para entrenar. Puedes apagar el historial, exportar tus datos o borrarlo todo cuando quieras.</p>
            <p className="landing__p">Usamos modelos abiertos —Qwen 3.5, DeepSeek-R1, gpt-oss— y cada trabajo (chat, visión, autocompletado, embeddings) lo atiende el modelo que mejor lo hace.</p>
          </div>
          <div><IlustracionPrivacidad /></div>
        </section>

        <section className="landing__fila landing__fila--inv">
          <div>
            <span className="landing__num">02 — Una cuenta, cuatro formas de usarla</span>
            <h2 className="landing__h2">El mismo clúster detrás del navegador, la terminal, el editor y tu código.</h2>
          </div>
          <ul className="landing__lista">
            {PRODUCTOS.map(([titulo, texto, a]) => (
              <li key={titulo}>
                <h3><Link to={a}>{titulo}</Link></h3>
                <p>{texto}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing__fila">
          <div>
            <span className="landing__num">03 — Para desarrolladores</span>
            <h2 className="landing__h2">Si ya usas el SDK de OpenAI, ya sabes usar lixbon.</h2>
            <p className="landing__p">Cambia dos valores y tu código funciona contra nuestros modelos. Streaming, <code>usage</code> con los tokens reales y los mismos errores que conoces.</p>
            <Link to="/docs/usar-api-key" className="landing__enlace">Recetas para Python, JavaScript y continue.dev <Flecha /></Link>
          </div>
          <pre className="landing__codigo"><code>{CODIGO}</code></pre>
        </section>

        <section className="landing__bloque">
          <span className="landing__num">04 — Precios</span>
          <h2 className="landing__h2">Planes con límites claros. La API, por tokens.</h2>
          <p className="landing__p">Todos los planes acceden a todos los modelos. Cancelas cuando quieras desde Ajustes.</p>
          <div className="landing__precios">
            {PLANES.map(([nombre, precio, periodo, lineas]) => (
              <div key={nombre} className="landing__precio">
                <h3>{nombre}</h3>
                <p className="landing__cifra">{precio}{periodo && <span> {periodo}</span>}</p>
                <p>{lineas.map((l) => <span key={l}>{l}<br /></span>)}</p>
              </div>
            ))}
          </div>
          <p className="landing__nota landing__enlaces"><Link to="/planes" className="landing__enlace">Ver los planes <Flecha /></Link><Link to="/docs/precios-api" className="landing__enlace">Precios de la API por modelo <Flecha /></Link></p>
        </section>

        <section className="landing__bloque">
          <span className="landing__num">05 — Preguntas frecuentes</span>
          <ul className="landing__faq">
            {FAQ.map(([q, a]) => <li key={q}><h3>{q}</h3><p>{a}</p></li>)}
          </ul>
        </section>

        <section className="landing__final">
          <h2 className="landing__h2">Empieza con el plan Gratuito.</h2>
          <p className="landing__p">Treinta mensajes al día para probar el chat, Visuals y el CLI. Sin tarjeta.</p>
          <Link to={user ? '/chat' : '/auth?mode=register'} className="pill-btn pill-btn--primary landing__btn">{user ? 'Ir al chat' : 'Crear cuenta'}</Link>
        </section>

        <footer className="landing__pie">
          <div><Logo /><p>Medellín, Colombia · © {new Date().getFullYear()}</p></div>
          <nav><Link to="/docs">Documentación</Link><Link to="/guias">Guías</Link><Link to="/aplicaciones">Aplicaciones</Link><Link to="/planes">Planes</Link></nav>
          <nav><Link to="/legal/privacidad">Privacidad</Link><Link to="/legal/terminos">Términos</Link><Link to="/legal/reembolsos">Reembolsos</Link><a href="mailto:soporte@lixbon.com">Soporte</a></nav>
        </footer>
      </main>
    </div>
  );
}
