---
id: LXO-100-attention-focus-contract
titulo: Contrato de foco y scroll de la Attention Inbox
tipo: contrato-ux
estado: vigente
ticket: LXO-100
componente: apps/desktop/src/ade/AttentionInbox.jsx
pruebas: apps/desktop/src/ade/AttentionInbox.test.jsx
base: fcb3a6c4
tags:
  - lxo-100
  - attention
  - foco
  - scroll
  - desktop
  - ux
---

# Contrato de foco y scroll de la Attention Inbox (LXO-100)

**Tipo:** contrato de comportamiento observable de la vista de Attention (solo lectura) del Desktop.
**Estado:** vigente para `apps/desktop/src/ade/AttentionInbox.jsx` en la base `fcb3a6c4`.
**Alcance:** el foco del DOM y el desplazamiento de la lista global de Attention. No describe el contrato
del Core, ni las queries, ni los comandos: la vista no resuelve, no pospone y no marca como leído.

Este documento existe para que un cambio futuro en el sondeo, la paginación o la rehidratación no rompa el
foco de quien está leyendo la lista. Describe el comportamiento **ya implementado**; no propone ninguno nuevo.

## 1. La identidad del foco es el ID durable de Attention

El foco se ancla al **ID durable de Attention** (`item.id`, por ejemplo `att_…`), nunca al índice visual de la
fila ni al nodo del DOM. El índice solo decide el *roving tabindex* (qué fila es el único tab stop).

Consecuencias:

- Si el orden de las filas cambia (por ejemplo, aparece una Attention más antigua), el foco sigue en la misma
  Attention, no en la misma posición.
- El ID sobrevive a la desaparición y reaparición de la fila: es la única forma de distinguir «la misma
  Attention, ahora en otra página» de «una Attention distinta que ocupa ese lugar».

## 2. Recuperación con cabecera fresca: el foco sigue al ID, no al lugar

El sondeo predeterminado (15 s) y cada lectura correcta de cabecera reinicianan las páginas anexadas, porque el
Core no ofrece una instantánea compartida entre páginas ni un change feed. Al llegar una cabecera nueva:

1. Si la Attention enfocada **está en la cabecera nueva**, el foco se conserva sobre ella sin más trabajo.
2. Si **no está**, la fila solo se busca cuando la última fila de la cabecera es **anterior** a la enfocada en el
   orden *keyset* (`created_at ASC, id ASC`) —o sea, la enfocada estaría en una página posterior— y además la
   cabecera declara que hay más páginas. La búsqueda usa **cursores frescos** (los de la cabecera nueva, nunca
   los de la sesión anterior) y se detiene como máximo en 20 páginas.
3. El resultado de esa búsqueda decide. Los estados son los literales que devuelve la búsqueda fresca
   (`AttentionInbox.jsx:329-367`):

| Estado | Qué lo produce (código) | Qué hace el componente |
|---|---|---|
| `found` | la página fresca contiene el ID buscado (`AttentionInbox.jsx:336`) | se rehidrata la página y el foco vuelve a esa Attention (`AttentionInbox.jsx:351-357`) |
| `absent` | la búsqueda fresca **terminó sin devolver el ID**: la página ya no declara más páginas (`!found.has_more`), no hay cursor siguiente (`!found.next_cursor`) o el recorrido *keyset* ya pasó la posición del foco (`passed`) — las tres condiciones en `AttentionInbox.jsx:338` | **respaldo determinista en la primera fila de la cabecera nueva** (`AttentionInbox.jsx:358-361`) |
| `unproven` | la consulta fresca falló (`.catch()` → `unproven`, `AttentionInbox.jsx:343`) o se agotó el tope de 20 páginas (`REHYDRATE_MAX_PAGES`, `AttentionInbox.jsx:68, 332, 341`) | **se conserva el ID y el foco no se mueve**; un sondeo posterior puede seguir probándolo (`AttentionInbox.jsx:362-366`) |

El estado `absent` **no afirma que la Attention haya dejado de existir**: afirma que la búsqueda fresca terminó
sin devolver el ID, y el componente deja de esperarla y aplica el respaldo. Solo en el caso `!found.has_more` la
búsqueda ha recorrido hasta el final del orden *keyset* y la ausencia queda establecida sobre la lista entera; en
`!found.next_cursor` el recorrido se corta porque el Core no ofrece cursor, y el código aplica el mismo respaldo
aunque las páginas siguientes sigan siendo desconocidas. En `unproven` no se afirma nada: la ausencia **no**
está probada y por eso el foco no se mueve a una fila ajena.

Mientras la búsqueda está en vuelo, «Cargar más» queda bloqueado. Si el usuario se fue a otro control, la
búsqueda no le roba el foco. Un fallo del Core o un cursor caducado **no** es una ausencia: la cabecera
retenida y las páginas anexadas se descartan, pero el ID del foco se conserva para rehidratarlo al reconectar.

## 3. Scroll: se suprime salvo que el nodo del foco sea otro

El scroll de la lista solo existe para *revelar* la fila enfocada, nunca para reposicionar la vista.

| Situación | Foco | Scroll |
|---|---|---|
| El nodo del DOM con el foco **sigue siendo el mismo** | No se vuelve a enfocar: el nodo conserva el foco DOM | **Ninguno.** Se respeta el desplazamiento que hizo el usuario, incluso si la fila quedó fuera de vista |
| El nodo del DOM con el foco **es un nodo de reemplazo** (la fila se retiró y se volvió a montar) | Se enfoca el nodo nuevo | `scrollIntoView({ block: 'nearest', inline: 'nearest' })`, y **solo si** la fila quedó fuera del área visible del **contenedor de scroll más cercano** (o del viewport si no hay ninguno) |

Es decir: `nearest` es el scroll mínimo de revelation y aplica **solo a un nodo de reemplazo**. Un nodo que ya
tenía el foco no se toca: la persona pudo desplazar la lista a propósito y devolver la fila a la vista sería
un salto no solicitado.

**Alcance del scroll.** La decisión de desplazar se mide contra **un** contenedor: el primer ancestro con
`overflowY` `auto|scroll|overlay` (`scrollContainerOf`, `AttentionInbox.jsx:70-75, 81`) y, si no hay ninguno,
contra el *viewport* (`AttentionInbox.jsx:82`). El `nearest` es el desplazamiento mínimo que la plataforma
aplique sobre los ancestros desplazables del nodo; este contrato **no** promete que un ancestro externo —un
scroller de página, por ejemplo— quede traído a la vista. Lo garantizado es que la fila queda dentro del área
visible del contenedor más cercano, que es el que la persona está mirando. El foco, además, se restituye con
`focus({ preventScroll: true })` (`AttentionInbox.jsx:79`): el foco no arrastra scroll por su cuenta.

## 4. El `focusout` de la retirada del nodo es un supuesto del harness, no una regla de plataforma

**jsdom no emite `focusout` al retirar del DOM el nodo enfocado.** Para poder ejercitar esa rama, el harness de
`AttentionInbox.test.jsx` **supone** que el runtime real del Desktop (Chromium/WebView2) sí emite un `focusout`
con `relatedTarget` `null` antes de retirar el nodo, y lo **emula a mano**: `emulateBlurOnRemoval()` intercepta
`Node.prototype.removeChild` y, si el nodo que se retira contiene al elemento enfocado, le despacha un `focusout`
(con `bubbles` y `relatedTarget: null`) antes de retirarlo (`AttentionInbox.test.jsx:123-145`).

**Ese supuesto no está verificado contra WebView2 real.** No es una regla de plataforma comprobada en este
repositorio: es una hipótesis del harness, enunciada como tal en el propio test
(`AttentionInbox.test.jsx:123-124`). Lo que el repositorio sí demuestra es (a) que jsdom no emite ese `focusout`
al retirar el nodo y (b) que la emulación hace **llegar** un `focusout` de verdad al nodo enfocado. El
comportamiento real de WebView2 al retirar el nodo enfocado queda **pendiente de validación en runtime**
(ver §6): hasta que se compruebe, este contrato describe la emulación del harness, no el comportamiento de la
plataforma.

Por eso la distinción la hace el componente de forma explícita y no solo a partir del evento: el `onBlur` de la
fila descarta el evento mientras `replacingRows.current` sea verdadero (`AttentionInbox.jsx:388-389, 728`), que
se activa al cambiar la cabecera o cuando la fila enfocada deja de pintarse (`AttentionInbox.jsx:400`). Así, la
retirada del nodo no se confunde con «la persona se fue».

El emulador devuelve además un registro (`{ focusouts, targets }`) que cuenta los `focusout` que **llegan de
verdad** al nodo enfocado, no los intentos (`AttentionInbox.test.jsx:129, 133-140`). Tres regresiones lo comprueban
como precondición —`expect(emulated.focusouts).toBeGreaterThan(0)` y
`expect(emulated.targets).toContain(<nodo enfocado>)`— y por eso **fallan** si la emulación deja de dispararse
o de observar la retirada, en vez de quedar en verde sin haber probado nada:

- `si el Core falla con el foco en una página anexada, al reconectar rehidrata con cursores frescos y restaura
  el foco` (`AttentionInbox.test.jsx:976, 986-987`);
- `si al reconectar la fila ya no existe, no salta a una fila ajena hasta probar su ausencia con cursores frescos`
  (`AttentionInbox.test.jsx:1031, 1037-1038`);
- `si un cursor caducado descarta las páginas con el foco en una fila anexada, rehidrata con la cabecera nueva y
  restaura el foco` (`AttentionInbox.test.jsx:1076, 1083-1084`).

**Limitación conocida del harness.** Otras tres regresiones invocan `emulateBlurOnRemoval()` pero **no**
comprueban que el `focusout` llegara: `un blur que provoca la sustitución del nodo por el refresh no cuenta como
perder el foco` (`AttentionInbox.test.jsx:718`), `mientras rehidrata la página anexada bloquea «Cargar más» y no
roba el foco si el usuario ya se fue` (`AttentionInbox.test.jsx:790`) y `al restaurar el foco en un nodo nuevo
fuera de vista hace el scroll mínimo (nearest) solo esa vez` (`AttentionInbox.test.jsx:939`). Si la emulación
dejara de funcionar, esas tres quedarían en verde **sin haber ejercitado la retirada del nodo**: prueban el
resto del contrato, no el `focusout` emulado. La limitación queda anotada aquí, sin corregir, porque este cambio
es **solo de documentación** y no toca las pruebas.

## 5. Qué cubre cada invariante

| # | Invariante | Regresión en `AttentionInbox.test.jsx` |
|---|---|---|
| 1 | El foco sigue al ID durable de Attention, no al índice ni al nodo | `conserva el foco por ID durable cuando una página anexada vuelve en la nueva cabecera` |
| 2 | Con cabecera fresca se rehidrata con cursores frescos y se restaura el foco | `si el Core falla con el foco en una página anexada, al reconectar rehidrata con cursores frescos y restaura el foco` · `si un cursor caducado descarta las páginas con el foco en una fila anexada, rehidrata con la cabecera nueva y restaura el foco` |
| 3 | Si la ausencia no está probada no se mueve el foco a una fila ajena; si la búsqueda fresca termina sin encontrar el ID, el respaldo es la primera fila de la cabecera nueva | `si al reconectar la fila ya no existe, no salta a una fila ajena hasta probar su ausencia con cursores frescos` · `si la consulta fresca no puede probar presencia ni ausencia conserva el ID y no mueve el foco a otra fila` · `un target realmente ausente cae a la primera fila nueva tras agotar la búsqueda fresca, también en varios sondeos` (cubre el estado `absent` de §2) |
| 4 | Un nodo que conserva el foco DOM no se desplaza al sondear | `un nodo que conserva el foco DOM no se desplaza al sondear, aunque el usuario lo sacara de vista` |
| 5 | `nearest` solo al restaurar el foco en un nodo de reemplazo, y solo frente al contenedor de scroll más cercano | `al restaurar el foco en un nodo nuevo fuera de vista hace el scroll mínimo (nearest) solo esa vez` |
| 6 | La retirada del nodo por el refresh no cuenta como perder el foco | `un blur que provoca la sustitución del nodo por el refresh no cuenta como perder el foco` |

Dos precisiones sobre esta tabla:

- La regresión `un target realmente ausente cae a la primera fila nueva tras agotar la búsqueda fresca, también
  en varios sondeos` es la que cubre el estado `absent` de §2: en su mock la página de la búsqueda fresca llega
  sin `has_more` ni `next_cursor` (`page()` usa `hasMore = false` por defecto,
  `AttentionInbox.test.jsx:40`), que es la primera de las tres condiciones de `AttentionInbox.jsx:338`. El
  «agotar la búsqueda fresca» del nombre se refiere a que la búsqueda **termina**; no es el tope de 20 páginas
  agotado, que corresponde al estado `unproven` (`AttentionInbox.jsx:341`).
- La invariante 6 se verifica contra el `focusout` **emulado** del harness (§4), no contra WebView2 real: su
  regresión invoca la emulación pero no comprueba que el evento llegara, así que prueba el resto del contrato
  (el `blur` no se cuenta como pérdida de foco), no la llegada del `focusout` emulado. El comportamiento real de
  WebView2 al retirar el nodo enfocado sigue pendiente de validación en runtime.

## 6. Límites de este contrato

- No describe el orden, la categoría ni la severidad de las Attention: las fija el Core
  (ver [`docs/core/ATTENTION.md`](../core/ATTENTION.md)).
- No describe los totales ni la paginación más allá de lo necesario para no perder el foco.
- No describe qué ocurre cuando la persona **quiere** dejar la lista: en ese caso el foco se libera con
  normalidad y el sondeo posterior no lo roba.
- La vista es de **solo lectura**: ninguna de estas reglas introduce mutaciones, y el foco no abre ni dispara
  Commands por sí mismo.
- El comportamiento descrito está verificado con un harness que emula Chromium (jsdom); no sustituye a una
  comprobación en WebView2 real, que sigue siendo la referencia de la plataforma. En particular, el `focusout`
  de la retirada del nodo es un **supuesto del harness** (§4) y no un comportamiento comprobado de WebView2: esa
  comprobación en runtime queda **pendiente**, y las tres regresiones que usan la emulación sin verificar que el
  evento llegara son una **limitación conocida** del harness (§4, §5).

## 7. Referencias

- Implementación: `apps/desktop/src/ade/AttentionInbox.jsx`
- Pruebas: `apps/desktop/src/ade/AttentionInbox.test.jsx`
- Modelo autoritativo de Attention: [`docs/core/ATTENTION.md`](../core/ATTENTION.md)
- Queries de solo lectura que sirven la lista: [`docs/core/QUERIES.md`](../core/QUERIES.md)
