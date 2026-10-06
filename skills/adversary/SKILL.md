---
name: adversary
description: >-
  Revisor adversarial de Lixbon. Con "/adversary <qué atacar>" lanzas un agente hijo con el rol
  adversario, que no intenta demostrar que algo funciona sino encontrar cómo se rompe (casos
  límite, errores ocultos, vulnerabilidades, suposiciones sin justificar), y respondes a cada
  uno de sus hallazgos: corriges o justificas. Úsala cuando el usuario escriba /adversary, pida
  "un adversario", "ataca esto", "busca cómo se rompe" o "revisión adversarial".
argument-hint: <qué atacar>
metadata:
  lxo-skill-version: 1
---

# Adversario de Lixbon

El adversario es solo lectura: puede ejecutar tests y comandos para demostrar fallos, pero no edita.
Su informe es una lista de hallazgos numerados por gravedad, cada uno con escenario, evidencia y
la pregunta que tú, como creador, debes responder.

## 1. Localiza `lxo`

Usa el primero que exista y sigue usándolo para todos los comandos:

1. La variable de entorno `LXO_BIN` (la tienen las tareas hijas que lanza Lixbon).
2. `{{LXO_BIN}}` (Lixbon IDE escribe aquí su ruta al instalar; si ves el marcador literal, sáltate este paso)
3. `lxo`, si está en el PATH.

Si responde "Lixbon no está abierto" o "orquestador desactivado", díselo al usuario: tiene que
abrir Lixbon y activar Ajustes → Orquestador. No lo simules con otros subagentes.

## 2. Lanza al adversario

1. `lxo status`. Si dice que no eres una tarea, crea un run:
   `lxo run create --objective "Revisión adversarial: <qué se ataca>" --agent <tu agente>`.
   Si eres una tarea hija (`LXO_TASK_ID`), mira `lxo status --json`: con `can_spawn` puedes lanzarlo
   como hija tuya; si no, pídeselo a tu coordinador con `lxo ask`.
2. Haz commit de lo que deba ver: parte de tu último commit, no de los cambios sin guardar.
3. Lánzalo con un encargo autocontenido (él no ve tu conversación):
   ```
   lxo spawn --role adversario --name "Adversario <tema>" --task "<qué atacar: diff (git diff <base>...<rama>), rama o archivos; contexto; decisiones tomadas y por qué>"
   ```
4. `lxo wait --timeout-ms 540000` hasta que llegue su informe; léelo entero.

## 3. Responde a cada hallazgo

Por cada hallazgo, corrígelo (con un test que lo cubra) o justifica por qué no aplica. No ignores
ninguno ni te quedes con el primero. Si el creador es otra hija, pásale los hallazgos con
`lxo continue <tarea>`.

Máximo **dos rondas** adversario → creador: tras corregir puedes pedirle una segunda pasada con el
diff nuevo. Lo que siga sin resolverse, cuéntaselo al usuario.

## 4. Informa al usuario

Qué hallazgos se corrigieron, cuáles se descartaron y por qué, y qué queda abierto.
Si creaste el run en el paso 2, ciérralo con `lxo run close`.
