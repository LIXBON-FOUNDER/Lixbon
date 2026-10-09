# Product Marketing Context

**Document version:** v2
**Last updated:** 2026-10-09

> **Regla de oro para todo el marketing de Lixbon:** habla como le explicarías Lixbon a un amigo. Primero lo que la persona gana, después (si hace falta) cómo funciona. Si una frase necesita saber qué es una GPU, un token o una API para entenderse, reescríbela.

## Product Overview
**One-liner:** Inteligencia artificial que trabaja para ti, no con tus datos.
**What it does:** Lixbon es un asistente de inteligencia artificial para tu día a día: conversas con él, te ayuda a escribir, resume documentos, diseña páginas web contigo y hasta te echa una mano programando. La diferencia es que lo que le cuentas se queda contigo: no se lo pasamos a otras empresas ni se usa para entrenar a nadie.
**Product category:** Asistente de IA privado; la alternativa a ChatGPT para quien cuida su información.
**Product type:** Servicio online con suscripción. Se usa desde el navegador, el ordenador (Windows), el móvil (Android) y la terminal.
**Business model:** Empiezas gratis y, si se te queda corto, pasas a un plan de pago mensual que cancelas con un clic.
- **Gratuito:** 0 $, 30 mensajes al día, sin tarjeta.
- **Pro:** 9,90 $/mes, 500 mensajes al día y acceso a todos los modelos.
- **Advance:** 24,90 $/mes, para quien usa Lixbon a fondo todos los días.
- **Para desarrolladores:** pago por uso con saldo prepago que no caduca.
*(Precios y límites: valores iniciales de `core/persistence/database.py`. Verificar contra producción antes de publicarlos. Límites técnicos exactos, como tokens/mes, solo en la página de planes, no en anuncios.)*

## Target Audience
**Target companies:** Personas que ya usan IA (o quieren empezar) para trabajar, estudiar o crear, y a las que les incomoda no saber qué pasa con lo que escriben. Hablan español. Dentro de ese grupo, los desarrolladores y freelancers son un segmento clave porque aprovechan todo el producto.
**Decision-makers:** La propia persona. Compra individual, se decide en minutos.
**Primary use case:** Tener un asistente de IA para todo sin regalar tu información.
**Jobs to be done:**
- "Ayúdame con mi trabajo (escribir, resumir, pensar ideas) sin que mis datos acaben en otra parte."
- "Hazme una página web bonita sin saber diseñar ni programar."
- "Échame una mano con mi código, en mi propio ordenador."
**Use cases:**
- Preguntar, redactar un correo o resumir un PDF desde el navegador.
- Describir una página web con tus palabras y compartirla con un enlace (Visuals).
- Programar con un asistente que lee tu proyecto y hace cambios por ti.
- Dejar al asistente trabajando en el ordenador y seguirlo desde el móvil.

## Personas
| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| Profesional o estudiante | Ahorrar tiempo y que sus cosas sigan siendo suyas | No se fía de pegar documentos del trabajo en ChatGPT | Un asistente completo que no comparte lo que le cuentas |
| Emprendedor o creador | Tener presencia online rápido y barato | Hacer una web le cuesta tiempo o dinero | Describe tu página y la diseñamos contigo en minutos |
| Desarrollador o freelancer | Programar más rápido y pagar menos | Las herramientas de IA son caras y están repartidas en mil apps | Chat, asistente de código y conexión para sus apps, todo con una cuenta y desde gratis |

## Problems & Pain Points
**Core problem:** Las herramientas de IA más conocidas son útiles, pero no sabes qué hacen con lo que les escribes.
**Why alternatives fall short:**
- Las grandes plataformas pueden usar tus conversaciones para entrenar sus modelos.
- Tener tu propia IA en casa exige un ordenador potente y conocimientos técnicos.
- Acabas pagando varias suscripciones: una para chatear, otra para programar, otra para diseñar.
**What it costs them:** Dinero en suscripciones sueltas, tiempo saltando de app en app y la incomodidad de compartir cosas privadas.
**Emotional tension:** "¿Debería pegar esto aquí?" Esa duda antes de compartir un documento del trabajo o algo personal.

## Competitive Landscape
**Direct:** ChatGPT, Claude, Gemini: muy conocidos y potentes, pero lo que escribes se queda en sus manos y la suscripción cuesta más.
**Direct (para quien programa):** Cursor, GitHub Copilot: buenos asistentes de código, pero son otra suscripción más y dependen de terceros.
**Secondary:** Herramientas sueltas para hacer webs (Wix, Framer) o para conectar IA a tus apps: resuelven una sola cosa.
**Indirect:** Instalar tu propia IA en casa: privado, pero difícil de montar y no te acompaña al móvil.

## Differentiation
**Key differentiators:**
- **Tus datos son tuyos.** No los compartimos con otras empresas de IA ni los usamos para entrenar. Puedes apagar el historial o borrarlo todo cuando quieras.
- **Una cuenta para todo.** Chat, diseño de webs y asistente de código, en el navegador, el ordenador, el móvil y la terminal, con tus conversaciones siempre a mano.
- **Empiezas gratis.** 30 mensajes al día sin poner tarjeta.
- **En español de verdad.** La app, la ayuda y los avisos están en tu idioma y se entienden.
- **Llévalo contigo.** Deja una tarea en marcha en el ordenador y síguela desde el móvil.
- **Para quien programa:** se conecta a sus aplicaciones cambiando una sola línea, porque habla el mismo idioma que OpenAI.
**How we do it differently:** Lixbon usa sus propios equipos para hacer funcionar la IA, en vez de reenviar tus mensajes a otras empresas.
**Why that's better:** Más privacidad, precios más bajos y todo en un solo sitio.
**Why customers choose us:** *(pendiente: confirmar con usuarios reales)*

## Objections
| Objection | Response |
|-----------|----------|
| "¿Será tan bueno como ChatGPT?" | Para lo del día a día (escribir, resumir, programar, diseñar) responde de sobra. Pruébalo gratis y júzgalo tú. |
| "¿Cómo sé que no usáis mis datos?" | No los compartimos ni entrenamos con ellos, y tú tienes el control: apaga el historial, descárgalo o bórralo desde Ajustes → Privacidad. |
| "Otra app más que aprender…" | Si sabes usar un chat, ya sabes usar Lixbon. Y como reúne varias herramientas, te ahorra apps. |
| (Devs) "No quiero rehacer mi integración." | Cambias una línea de configuración y tu código sigue funcionando. |

**Anti-persona:** Grandes empresas que exigen contratos y certificaciones formales, quien necesita sí o sí el modelo más potente del mercado cueste lo que cueste, y usuarios de Mac o iPhone que buscan app nativa (de momento la app de escritorio es para Windows y la móvil para Android).

## Switching Dynamics
**Push:** La duda sobre qué pasa con lo que escribes y el gasto en varias suscripciones.
**Pull:** Privacidad, todo en un mismo sitio, gratis para empezar y en español.
**Habit:** Ya usan ChatGPT y "les va bien".
**Anxiety:** ¿Responderá igual de bien? ¿Seguirá existiendo dentro de un año? ¿Perderé mis conversaciones?

## Customer Language
**How they describe the problem:**
- *(pendiente: recoger frases literales de usuarios)*
**How they describe us:**
- *(pendiente)*
**Words to use:** tus datos son tuyos, privado, asistente, conversa, te ayuda, en minutos, gratis, sin tarjeta, una cuenta, en español, cancela cuando quieras.
**Words to avoid:** jerga técnica en piezas para el público general (ver tabla "Dicho así"); "ilimitado" (solo Advance tiene mensajes ilimitados al día, y con tope mensual); "revolucionario", "hacker", "disruptivo"; promesas de que es "mejor que ChatGPT" en todo.
**Dicho así (traducciones de jerga):**
| En vez de… | Di… |
|------------|-----|
| LLM, modelos | inteligencia artificial, asistente |
| Modelos abiertos en GPUs propias | Lixbon funciona en sus propios equipos, sin pasar tus datos a otras empresas |
| Tokens / cuota | mensajes, uso del mes |
| API compatible con OpenAI, `base_url` | se conecta a tus apps cambiando una línea (solo en piezas para devs) |
| CLI | asistente en la terminal (solo para devs) |
| IDE / desktop | app para tu ordenador |
| Agente que edita archivos y ejecuta comandos | asistente que trabaja en tu proyecto por ti |
| MCP | conéctalo con tus otras herramientas |
| Control remoto (`/remote`) | sigue y guía tu tarea desde el móvil |
| Streaming | ves la respuesta mientras se escribe |

**Glossary:**
| Term | Meaning |
|------|---------|
| Visuals | Páginas web y diseños que creas conversando y compartes con un enlace |
| Plan Gratuito / Pro / Advance | Los tres planes de Lixbon |

## Brand Voice
**Tone:** Cercano, cálido y claro, con confianza tranquila. Como un amigo que sabe de tecnología y te la explica sin hacerte sentir torpe.
**Style:** Frases cortas, tuteo, verbos de acción ("conversa", "crea", "comparte"). Primero el beneficio, luego el detalle. Ejemplos concretos de la vida real antes que especificaciones. Para devs se puede bajar al detalle técnico, pero siempre abriendo con lo que ganan.
**Personality:** Cercana, honesta, clara, serena, útil.

## Proof Points
**Metrics:** *(pendiente)*
**Customers:** *(pendiente)*
**Testimonials:**
> *(pendiente)*
**Value themes:**
| Theme | Proof |
|-------|-------|
| Privacidad | No se usa para entrenar; puedes apagar, descargar o borrar tu historial |
| Todo en uno | Chat, webs y código con la misma cuenta en navegador, ordenador, móvil y terminal |
| Fácil de empezar | Gratis, sin tarjeta, en español |

## Goals
**Business goal:** Que más gente pruebe Lixbon gratis y se quede en Pro o Advance.
**Conversion action:** Crear cuenta gratis → conseguir algo útil en menos de 10 minutos → pasar a un plan de pago.
**Current metrics:** *(pendiente)*

## Changelog
*Newest first. One line per revision: what changed and why.*
- v2 (2026-10-09) — Voz de marca reescrita a cercana y no técnica; todo el documento pasado a lenguaje llano, público ampliado al usuario general (devs como segmento clave) y tabla "Dicho así" para traducir la jerga. Motivo: el usuario quiere un marketing más amigable, atractivo y entendible.
- v1 (2026-10-09) — Initial context, auto-drafted from README, PRODUCT.md, landing copy, plans seed (core/persistence/database.py) and the marketing-lxo skill.
