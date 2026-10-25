// decisions.js — decisiones de diseño tomadas en la maqueta (Problem / Options / Decision / Reason). Misma lista que docs/mockup/DISENO.md.
export const DECISIONS = [
  { id: 'D1', area: 'Aislamiento', problem: 'Dónde vive la maqueta sin contaminar producción.', options: 'Editar src/ade · carpeta nueva src/mockup · rama de producción', decision: 'Rama design/lixbon-unified-ade-mockup (derivada de ui-ade-architecture), worktree propio, todo en src/mockup + mockup.html fuera del build.', reason: 'src/ade ya fue presentada como prototipo de arquitectura; se importa solo la identidad visual (tokens, Icons) y no se modifica ningún archivo existente.' },
  { id: 'D2', area: 'Sidebar', problem: 'Project → Task → Attempt es pesado cuando casi todo es 1 Attempt.', options: 'Siempre 3 niveles · siempre plano · adaptativo', decision: 'Adaptativo: 1 Attempt ⇒ la Task es UNA fila; N Attempts ⇒ la Task es grupo con filas por Attempt (máx. 3 + “+N agents”).', reason: 'Conserva el mapa espacial tipo Orca sin pagar niveles vacíos; el Core sigue modelando Task/Attempt/Worktree por separado.' },
  { id: 'D3', area: 'Estados', problem: 'Mezclar “el agente trabaja” con “necesito a una persona”.', options: 'Un solo badge por fila · dos ejes', decision: 'Dos ejes: estado de ejecución (forma+color) y Attention (marcador ámbar “!”). Unread es un tercer eje (punto). Waiting siempre lleva causa.', reason: 'Un agente puede trabajar sin pedir nada; si todo es rojo, nada lo es. La forma distingue sin depender solo del color.' },
  { id: 'D4', area: 'Estados', problem: 'Qué color tiene “Review ready”.', options: 'Verde (igual que Completed) · lima de marca · púrpura', decision: 'Púrpura (--merged) con glifo de ojo; Completed es verde con check.', reason: 'Review ready ≠ terminado: necesita una persona. Debe distinguirse de Completed incluso en escala de grises.' },
  { id: 'D5', area: 'Sidebar', problem: 'Mostrar el host en cada fila o no.', options: 'Siempre · nunca · solo cuando importa', decision: 'Solo si es remoto u offline (más “Always show host” en el filtro). El host SIEMPRE está en el encabezado de la Task, el IDE y las decisiones.', reason: 'Evita “LOCAL” repetido; nunca se oculta donde alguien puede equivocarse.' },
  { id: 'D6', area: 'Composer', problem: 'Qué hace Enter con el agente ocupado.', options: 'Queue · Steer · adaptativo por superficie', decision: 'Enter = Queue (configurable en el menú). Steer = Ctrl+Enter; Stop & Send = Ctrl+Shift+Enter con confirmación; Fork abre un diálogo. Se muestra qué hará Enter ANTES de enviar.', reason: 'Queue es lo más conservador y portable entre proveedores. Si un proveedor no puede hacer Steer, se degrada de forma explícita: no se finge.' },
  { id: 'D7', area: 'Composer', problem: 'Dónde ver lo pendiente sin ocupar la pantalla.', options: 'Panel lateral · dentro del transcript · dock sobre el composer', decision: 'Dock compacto sobre el composer: reordenar, editar, borrar, Queue↔Steer, → Attempt; la fila 1 marcada como “next”. Cada ítem lleva su procedencia (ADE/CLI/Mobile/IDE).', reason: 'Es intención pendiente, no transcript; y muestra continuidad entre superficies.' },
  { id: 'D8', area: 'Review', problem: 'El diff de miles de líneas como punto de partida.', options: 'Diff primero · Proof Pack primero', decision: 'Proof Pack primero (qué intentó, qué cambió, qué comprobó, qué falló, qué NO pudo verificar, riesgo, qué necesita una persona). Cada evidencia lleva su origen: auto / agent says / inferred.', reason: 'Reducir el costo de verificar sin prometer una cifra: el “40% menos” NO se afirma en ninguna pantalla.' },
  { id: 'D9', area: 'Review', problem: 'Qué significa “Accept”.', options: 'Aceptar lo que haya ahora · aceptar una revisión', decision: 'Accept @ commit: aceptar solo vale sobre la revisión mostrada (también en móvil y CLI). Los comentarios se acumulan y viajan como UN paquete; la siguiente revisión abre en “Since last review”.', reason: 'Una Review apunta a Attempt + commit, no a una carpeta mutable.' },
  { id: 'D10', area: 'Navegación', problem: 'Desktop no debe sentirse como un móvil ampliado.', options: 'Tabs superiores + bottom nav · master-detail', decision: 'Desktop: sidebar permanente + canvas + inspector (master-detail) y pestañas de vista arriba solo para vistas globales. Mobile: bottom tabs (Home/Tasks/Attention/Hosts).', reason: 'Cada superficie usa su patrón nativo; comparten vocabulario, estados e iconos.' },
  { id: 'D11', area: 'ADE↔IDE', problem: 'Creer que se edita un branch mientras el agente modifica otro.', options: 'Chip discreto · barra permanente', decision: 'Barra de contexto permanente en el IDE (Task → Attempt → branch → worktree → agent → host), banner “AI WORK” en el archivo, y aviso “Location mismatch” si el runtime discrepa. Take Over / Return to Agent existen en ADE e IDE.', reason: 'Es preferible mostrar incertidumbre a mostrar una ubicación falsa.' },
  { id: 'D12', area: 'Mobile', problem: 'Qué puede hacer el teléfono.', options: 'Mini-IDE · consola de decisión', decision: 'Remote Control / Attention: aprobar con alcance, responder, Queue/Steer/Stop, Proof Pack resumido y “Open full review on Desktop”. High risk exige leer el comando y no ofrece “always”.', reason: 'La ejecución sigue en el host; el móvil decide con contexto, no edita.' },
  { id: 'D13', area: 'CLI', problem: 'Que `lxo` no invente otro modelo mental.', options: 'Comandos propios · mismo vocabulario e ids', decision: 'lxo usa Project/Task/Attempt/Agent/Worktree/Attention/Review/Host y los estados de la tabla común (working:tool, waiting:approval…). Lo enviado desde CLI aparece en el ADE con la etiqueta de procedencia “CLI”. Acciones destructivas piden --yes o confirmación.', reason: 'La procedencia informa; no crea una categoría aparte.' },
  { id: 'D14', area: 'Lenguaje', problem: 'Idioma de la interfaz de la maqueta.', options: 'Todo en español · todo en inglés · mixto por función', decision: 'Términos de producto en inglés (Task, Attempt, Attention, Queue, Steer, Proof Pack, lxo…) como en el documento de investigación; texto explicativo del showcase y la guía en español.', reason: 'Coincide con los wireframes del documento. La localización es una decisión posterior.' },
  { id: 'D15', area: 'Sidebar', problem: 'Filas que se reordenan al cambiar de estado.', options: 'Ordenar por estado · orden estable', decision: 'Orden estable; el estado se ve en la marca, no en la posición. Un evento de fondo nunca cambia el Active Workspace.', reason: 'Memoria espacial y “no robar foco”.' },
  { id: 'D16', area: 'Modelo', problem: 'Coordinador → tareas hijas (hueco detectado en la maqueta anterior).', options: 'Anidar en el sidebar · solo en inspector y Mission Map', decision: 'Provisional: se muestra como “child of Run” en la cabecera y el Inspector y como aristas en Mission Map. Sin tocar el sidebar todavía.', reason: 'Sigue abierto cómo representar Run→tareas en el árbol principal; la maqueta lo hace visible sin fijarlo.' },
];

export const QUESTIONS = [
  ['¿Cómo se ve Lixbon como ADE?', 'ade', 'workspace'],
  ['¿Cómo se diferencia del IDE tradicional?', 'ide', null],
  ['¿Cómo manejo cinco agentes a la vez?', 'ade', 'workspace'],
  ['¿Dónde veo los worktrees?', 'ade', 'hosts'],
  ['¿Cómo sé qué necesita mi atención?', 'ade', 'attention'],
  ['¿Cómo envío una instrucción mientras un agente trabaja?', 'ade', 'workspace'],
  ['¿Cómo comparo dos Attempts?', 'ade', 'compare'],
  ['¿Cómo reviso el trabajo de un agente?', 'ade', 'proof'],
  ['¿Cómo paso del ADE al código?', 'ide', null],
  ['¿Qué puedo hacer desde el teléfono?', 'mobile', null],
  ['¿Cómo continúa una Task al cambiar de dispositivo?', 'flow', null],
  ['¿Qué papel cumple el CLI?', 'cli', null],
  ['¿Las cuatro superficies se sienten como Lixbon?', 'all', null],
];

export const SIMULATED = [
  'Todos los datos (proyectos, Tasks, Attempts, hosts, uso, Proof Packs, diffs) son ficticios y viven en memoria (store.js).',
  'Los agentes no existen: los cambios de estado, el fin de turno, Steer, Fork, aprobaciones y reconexión de hosts son setState/setTimeout.',
  'No hay Git, worktrees, terminal ni IPC reales; las rutas y ramas son texto.',
  'Mobile y CLI no tienen transporte: comparten el store con el ADE para mostrar la continuidad.',
  'Los botones “sim” (End turn, Reconnect host) y el menú Simulate no son parte del producto.',
];
