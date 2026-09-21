# Sistema de límites de uso multi-cliente

Cómo funciona el modelo de límites de Claude (sesión de 5h + cap semanal, compartido entre CLI, web y app) y cómo se diseñaría algo equivalente desde cero.

---

## Parte 1 — El modelo de Claude

### 1.1 Dos relojes independientes

No es un límite, son dos contadores corriendo en paralelo con reglas distintas:

| | Sesión | Semanal |
|---|---|---|
| Ventana | 5 horas | 7 días |
| Arranque | Con el primer mensaje que consume capacidad | Día y hora fijos asignados a la cuenta |
| Reinicio | 5h exactas después de ese primer mensaje | En el mismo instante cada semana, sin importar cuándo empezaste a usar el servicio |
| Propósito | Limitar el ritmo (ráfagas) | Limitar el volumen total |

La clave de diseño: **cualquiera de los dos te corta**. Puedes tener 0% de sesión y aun así estar bloqueado por el semanal. Por eso el mensaje de error tiene que decir *cuál* se agotó — "session limit" y "weekly limit" son mensajes distintos porque la acción del usuario es distinta (esperar horas vs. esperar días).

### 1.2 La sesión no es una sliding window pura

Esto es más sutil de lo que parece y es donde la mayoría de implementaciones se complican de más.

La ventana de 5h **no** es un log deslizante donde cada token individual expira 5 horas después de haberse gastado. Es una **sesión**: se abre con tu primer mensaje, corre 5 horas, y al cerrarse se libera de golpe toda la capacidad consumida en ella. Si mandas el primer prompt a las 5:29pm, la ventana muere a las 10:29pm sin importar cuántos mensajes mandaste en el medio.

Diferencia práctica:

- **Sliding window log**: guardas cada evento con timestamp y sumas los de las últimas 5h en cada request. Exacto, pero caro (crece con el volumen) y el usuario nunca sabe bien cuándo recupera capacidad.
- **Sesión / fixed window con inicio dinámico**: un solo contador con un `expires_at`. O(1), trivial de cachear, y le puedes dar al usuario una hora concreta de reinicio. Es lo que usa Claude.

El costo del segundo enfoque es el efecto borde: un usuario puede vaciar la ventana al final de una sesión y volver a vaciarla al inicio de la siguiente. Anthropic lo acepta a cambio de la simplicidad y la predictibilidad para el usuario. Para tu proyecto esa es casi siempre la decisión correcta.

### 1.3 El pool es de la cuenta, no del cliente

CLI, chat web, app de escritorio y móvil consumen del **mismo** presupuesto. Una tarde de chat en la web te deja sin capacidad para la noche en la CLI.

Esto no es una limitación, es la decisión arquitectónica central: el contador vive colgado del `account_id`, y los clientes son solo superficies que presentan la misma cuenta. Si el contador viviera por cliente tendrías que resolver el problema imposible de repartir cuota entre superficies, y el usuario haría arbitraje abriendo la CLI cuando se le acabe la web.

### 1.4 Se mide consumo ponderado, no tokens crudos

La barra no es un tanque de N tokens. Cada turno suma una cantidad que depende de:

- **Tokens de entrada** — incluye *todo el contexto reenviado*, no solo lo que escribiste. Por eso el turno 50 de una conversación cuesta mucho más que el turno 2 aunque escribas lo mismo.
- **Tokens de salida** — pesan bastante más que los de entrada.
- **Cache reads** — el mismo contexto ya cacheado cuenta mucho menos que reenviarlo en frío.
- **Cache writes** — pesan algo más que la entrada normal.
- **El modelo** — un modelo grande consume mucho más por unidad de trabajo que uno pequeño.

La forma general es una suma ponderada:

```
costo = w_in·tokens_in + w_out·tokens_out + w_cache_r·cache_read + w_cache_w·cache_write
costo_final = costo · multiplicador_modelo
```

Los pesos exactos de Claude no son públicos, pero la estructura sí.

### 1.5 Por qué se expone en porcentaje y no en números absolutos

Anthropic publica multiplicadores relativos entre planes en lugar de cifras absolutas. Eso tiene una razón de ingeniería, no solo de marketing: **te deja ajustar la capacidad real según la carga del sistema sin romper una promesa numérica**. Si prometes "7M de tokens semanales" te casaste con ese número; si prometes "5x el plan básico", puedes mover el baseline.

El costo es que el usuario no puede planear con precisión, y por eso el panel de uso propio (`/usage`) pasa a ser la única fuente de verdad.

### 1.6 Sub-límites anidados

Encima del cap semanal general puede correr otro cap semanal solo para el modelo más caro. Son buckets que se evalúan en conjunto: un request con el modelo caro consume del bucket general **y** del específico, y se rechaza si cualquiera de los dos está lleno.

Detalle relevante: en el plan básico los modelos comparten un solo pool (usar el modelo caro te come el margen del barato), mientras que en planes superiores cada modelo tiene su bucket separado. Es una palanca de diferenciación de planes sin cambiar la arquitectura.

---

## Parte 2 — Cómo adaptarlo a tu sistema

### 2.1 Principio no negociable: el metering es servidor

Los clientes (CLI, web, app) **nunca** llevan la cuenta. Solo la muestran. Cualquier contador en el cliente es una sugerencia que el usuario puede falsificar borrando un archivo local.

```
CLI ─┐
Web ─┼──► API Gateway ──► Servicio de Metering ──► Modelo
App ─┘                          │
                                └──► Store de contadores (Redis) + Event log (MySQL)
```

El servicio de metering hace tres cosas en cada request: **verificar**, **reservar**, **reconciliar**.

### 2.2 Unidad de cuenta

Define una unidad interna propia —llámala crédito, unidad, o como quieras— y convierte todo a ella antes de contar. Nunca cuentes "requests" ni "mensajes": un mensaje de 200 tokens y uno de 180K tokens no pueden valer lo mismo.

Esa tabla de pesos (por modelo, por tipo de token) debe vivir en **configuración, no en código**. La vas a ajustar. Si está hardcodeada en el servicio de metering, cada recalibración es un deploy.

### 2.3 Modelo de datos

Dos capas, con roles distintos:

**Event log (fuente de verdad, append-only).** Una fila por request completado: cuenta, superficie de origen, modelo, tokens desglosados por tipo, unidades calculadas, timestamp, idempotency key. Nunca se actualiza ni se borra. Es lo que te permite recalcular históricos si cambias los pesos, auditar una disputa, y reconstruir los contadores si Redis se cae.

**Contadores (caché operativa).** Una fila o key por (cuenta, tipo de ventana, bucket): unidades consumidas, `window_started_at`, `window_expires_at`. Es lo que consultas en caliente. Debe ser reconstruible desde el event log — si no lo es, tienes un problema.

Para el bucket de sesión, la lógica de apertura es: si no existe contador o su `expires_at` ya pasó, se crea uno nuevo con `expires_at = now + 5h` y consumo en cero. Ahí está toda la magia de la ventana dinámica.

Para el semanal, el ancla se asigna una vez al crear la cuenta (por ejemplo, distribuida pseudo-aleatoriamente sobre los 7×24 slots de la semana) y se guarda como propiedad de la cuenta. **No la derives de la fecha de suscripción**: eso concentra los resets en picos y te deja sin forma de repartir la carga.

### 2.4 El problema real: no sabes el costo hasta terminar

Este es el punto que más duele al implementarlo. Cuando llega el request conoces los tokens de entrada, pero los de salida no existen todavía —y con streaming, el costo se va acumulando mientras respondes.

El patrón es **reserva + reconciliación**:

1. **Pre-flight**: calculas el costo de entrada (exacto) más una estimación del costo de salida (por ejemplo, el `max_tokens` solicitado, o un p95 histórico). Verificas contra todos los buckets aplicables. Si alguno no alcanza, rechazas antes de gastar cómputo.
2. **Reserva**: descuentas ese estimado de forma atómica. Esto es lo que evita que 10 requests concurrentes pasen todos la verificación y se pasen del límite entre todos.
3. **Post-flight**: al terminar el stream conoces el consumo real. Ajustas la diferencia (casi siempre devolviendo, porque el estimado suele ser generoso) y escribes el evento definitivo.
4. **Timeout de reserva**: si el request muere sin reconciliar, la reserva debe expirar sola. Si no, una desconexión le roba cuota al usuario para siempre.

La atomicidad del paso 2 se resuelve con un script Lua en Redis o una transacción con bloqueo; lo importante es que leer-verificar-escribir sea una sola operación indivisible.

### 2.5 Evaluación multi-bucket

La verificación no es contra un límite sino contra un conjunto. El patrón:

```
buckets_aplicables = [sesión, semanal_global, semanal_modelo?]
si alguno no tiene espacio → rechazar, indicando CUÁL falló y cuándo se reinicia
si todos tienen espacio     → consumir de TODOS
```

Dos detalles que importan:

- El rechazo debe nombrar el bucket concreto y devolver el `reset_at` correspondiente. Un "429 Too Many Requests" genérico es inútil para el usuario.
- El consumo tiene que ser todo-o-nada entre buckets. Si descuentas del semanal y luego falla el de sesión, quedaste con contadores inconsistentes.

### 2.6 Identidad y superficies

Cada cliente se autentica y resuelve a un `account_id`. La superficie (`cli`, `web`, `app`, `agente`) se registra en el evento pero **no** particiona el contador. Sirve para tres cosas:

- Analítica: saber qué superficie consume qué.
- Desglose en el panel de uso ("tu CLI consumió el 70% de esta semana").
- Políticas diferenciadas si algún día las necesitas — por ejemplo, que los agentes autónomos o jobs programados tengan su propio bucket para que no se coman la cuota del trabajo interactivo. Este caso es real y vale la pena dejarlo previsto aunque no lo implementes ya.

### 2.7 Qué exponer a los clientes

Un solo endpoint de uso que devuelva, por bucket: porcentaje consumido, `reset_at`, y opcionalmente un desglose por modelo y por superficie. Los tres clientes consumen el mismo endpoint y solo cambian la presentación:

- **CLI**: comando `/usage` con barras en texto, y opcionalmente el porcentaje en la status line para tenerlo siempre visible.
- **Web / app**: sección de ajustes con las mismas barras y las horas de reinicio en la zona horaria del usuario.

Adicionalmente, devuelve el estado en headers de cada respuesta del endpoint principal (estilo `X-RateLimit-Remaining` / `X-RateLimit-Reset`). Así los clientes actualizan su indicador sin tener que hacer polling.

### 2.8 UX del límite

Tres cosas que marcan la diferencia entre un sistema usable y uno frustrante:

- **Avisar antes, no después.** Notificación al 50/75/90%. Que el usuario se entere al 100% es un fallo de diseño: le cortas a mitad de una tarea sin darle oportunidad de priorizar lo que le queda.
- **Decir qué hacer.** "Se agotó tu sesión, vuelve en 2h 14m" vs. "se agotó tu semana, vuelve el jueves" son situaciones completamente distintas.
- **Ofrecer degradación en vez de bloqueo.** Antes de cortar, sugerir cambiar a un modelo más barato, compactar el contexto, o habilitar consumo adicional. Cortar en seco es la última opción, no la primera.

### 2.9 Recomendaciones de eficiencia que se derivan del modelo

Si expones el modelo de costos con honestidad, el usuario puede optimizar. Las tres palancas reales, en orden de impacto:

1. Usar el modelo caro solo donde aporta; el barato para ejecución rutinaria.
2. Controlar el crecimiento del contexto — compactar o reiniciar sesión. Arrastrar 200K tokens de historia en cada turno vacía la barra sin que el usuario escriba nada.
3. Aprovechar el caché: mantener el prefijo estable (instrucciones del sistema, archivos de referencia) para que se lea de caché en vez de reenviarse en frío.

---

## Resumen de decisiones

| Decisión | Opción recomendada | Por qué |
|---|---|---|
| Tipo de ventana corta | Sesión con inicio dinámico | O(1), reinicio predecible para el usuario |
| Tipo de ventana larga | Fixed window anclada por cuenta | Distribuye la carga de resets |
| Alcance del contador | Por cuenta, no por cliente | Evita arbitraje entre superficies |
| Unidad | Crédito interno ponderado | Desacopla el límite del precio y del modelo |
| Pesos | En configuración | Los vas a recalibrar |
| Verificación | Reserva atómica + reconciliación | Concurrencia y streaming |
| Fuente de verdad | Event log append-only | Auditoría y recálculo |
| Exposición | Porcentaje + `reset_at` | Flexibilidad operativa |

---

## Referencias

- [Usage limit best practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)
- [How do usage and length limits work?](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)