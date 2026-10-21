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
3. El resultado de esa búsqueda decide:
   - **encontrada** → se rehidrata la página y el foco vuelve a esa Attention;
   - **ausencia probada** → respaldo determinista en la primera fila de la cabecera nueva;
   - **no probada** (error, sin más páginas o tope agotado) → **se conserva el ID y el foco no se mueve**;
     un sondeo posterior puede seguir probándolo.

Mientras la búsqueda está en vuelo, «Cargar más» queda bloqueado. Si el usuario se fue a otro control, la
búsqueda no le roba el foco. Un fallo del Core o un cursor caducado **no** es una ausencia: la cabecera
retenida y las páginas anexadas se descartan, pero el ID del foco se conserva para rehidratarlo al reconectar.

## 3. Scroll: se suprime salvo que el nodo del foco sea otro

El scroll de la lista solo existe para *revelar* la fila enfocada, nunca para reposicionar la vista.

| Situación | Foco | Scroll |
|---|---|---|
| El nodo del DOM con el foco **sigue siendo el mismo** | No se vuelve a enfocar: el nodo conserva el foco DOM | **Ninguno.** Se respeta el desplazamiento que hizo el usuario, incluso si la fila quedó fuera de vista |
| El nodo del DOM con el foco **es un nodo de reemplazo** (la fila se retiró y se volvió a montar) | Se enfoca el nodo nuevo | `scrollIntoView({ block: 'nearest', inline: 'nearest' })`, y **solo si** la fila quedó fuera del área visible del contenedor de scroll (o del viewport si no hay contenedor) |

Es decir: `nearest` es el scroll mínimo de revelation y aplica **solo a un nodo de reemplazo**. Un nodo que ya
tenía el foco no se toca: la persona pudo desplazar la lista a propósito y devolver la fila a la vista sería
un salto no solicitado.

## 4. El harness de pruebas emula el `focusout` de WebView2/Chromium

**jsdom no emite `focusout` al retirar del DOM el nodo enfocado.** Chromium —y por tanto WebView2, que es el
runtime del Desktop— sí lo emite (regla de corrección de foco: `focusout` con `relatedTarget` `null` antes de
retirar el nodo). Esa diferencia es observable en el producto: en Chromium la retirada de la fila enfocada
dispara el `blur` de React, y el componente debe reconocerla como **sustitución de nodo** y no como «la persona
se fue».

Por eso el harness de `AttentionInbox.test.jsx` emula ese comportamiento a mano: `emulateBlurOnRemoval()`
intercepta `Node.prototype.removeChild` y, si el nodo que se retira contiene al elemento enfocado, le despacha
un `focusout` (con `bubbles` y `relatedTarget: null`) antes de retirarlo.

El emulador devuelve además un registro (`{ focusouts, targets }`) que cuenta los `focusout` que **llegan de
verdad** al nodo enfocado. Las regresiones de §2 que dependen de la retirada del nodo (fallo del Core y cursor
caducado) lo comprueban: si la emulación dejara de dispararse —o de observar la retirada— esas pruebas **fallan**
en vez de quedar en verde sin haber probado nada. Una regresión que depende de una emulación debe poder
probarla.

## 5. Qué cubre cada invariante

| # | Invariante | Regresión en `AttentionInbox.test.jsx` |
|---|---|---|
| 1 | El foco sigue al ID durable de Attention, no al índice ni al nodo | `conserva el foco por ID durable cuando una página anexada vuelve en la nueva cabecera` |
| 2 | Con cabecera fresca se rehidrata con cursores frescos y se restaura el foco | `si el Core falla con el foco en una página anexada, al reconectar rehidrata con cursores frescos y restaura el foco` · `si un cursor caducado descarta las páginas con el foco en una fila anexada, rehidrata con la cabecera nueva y restaura el foco` |
| 3 | Sin probar la ausencia no se mueve el foco a una fila ajena | `si al reconectar la fila ya no existe, no salta a una fila ajena hasta probar su ausencia con cursores frescos` · `si la consulta fresca no puede probar presencia ni ausencia conserva el ID y no mueve el foco a otra fila` |
| 4 | Un nodo que conserva el foco DOM no se desplaza al sondear | `un nodo que conserva el foco DOM no se desplaza al sondear, aunque el usuario lo sacara de vista` |
| 5 | `nearest` solo al restaurar el foco en un nodo de reemplazo | `al restaurar el foco en un nodo nuevo fuera de vista hace el scroll mínimo (nearest) solo esa vez` |
| 6 | La retirada del nodo por el refresh no cuenta como perder el foco | `un blur que provoca la sustitución del nodo por el refresh no cuenta como perder el foco` |

## 6. Límites de este contrato

- No describe el orden, la categoría ni la severidad de las Attention: las fija el Core
  (ver [`docs/core/ATTENTION.md`](../core/ATTENTION.md)).
- No describe los totales ni la paginación más allá de lo necesario para no perder el foco.
- No describe qué ocurre cuando la persona **quiere** dejar la lista: en ese caso el foco se libera con
  normalidad y el sondeo posterior no lo roba.
- La vista es de **solo lectura**: ninguna de estas reglas introduce mutaciones, y el foco no abre ni dispara
  Commands por sí mismo.
- El comportamiento descrito está verificado con un harness que emula Chromium (jsdom); no sustituye a una
  comprobación en WebView2 real, que sigue siendo la referencia de la plataforma.

## 7. Referencias

- Implementación: `apps/desktop/src/ade/AttentionInbox.jsx`
- Pruebas: `apps/desktop/src/ade/AttentionInbox.test.jsx`
- Modelo autoritativo de Attention: [`docs/core/ATTENTION.md`](../core/ATTENTION.md)
- Queries de solo lectura que sirven la lista: [`docs/core/QUERIES.md`](../core/QUERIES.md)
