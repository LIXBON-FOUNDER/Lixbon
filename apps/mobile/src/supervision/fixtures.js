// supervision/fixtures.js — datos de ejemplo del prototipo de supervisión. Las
// horas se calculan respecto a `now` para que «hace 2 min» siga siendo cierto
// cada vez que se abre. Cubren un caso de cada estado que hay que validar.
// Sin secretos ni diffs: fixtures.test.js lo comprueba.

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

export function buildFixtures(now) {
  // `live`: el host late solo. El portátil sigue conectado pero no late
  // (desactualizado) hasta que se actualiza a mano.
  const hosts = [
    { id: 'h-studio', name: 'Desktop · estudio', kind: 'desktop', os: 'Windows 11', connected: true, live: true, lastSeenAt: now - 6 * S },
    { id: 'h-laptop', name: 'Portátil', kind: 'desktop', os: 'macOS 15', connected: true, live: false, lastSeenAt: now - 4 * MIN },
    { id: 'h-ci', name: 'Servidor de CI', kind: 'cli', os: 'Ubuntu 24.04', connected: false, live: false, lastSeenAt: now - 3 * H },
  ];

  const projects = [
    { id: 'p-core', name: 'core' },
    { id: 'p-web', name: 'lixbon-web' },
    { id: 'p-mobile', name: 'mobile' },
  ];

  const tasks = [
    {
      id: 't-migracion',
      projectId: 'p-core',
      hostId: 'h-studio',
      agent: 'claude',
      title: 'Migrar la tabla de sesiones a UUID',
      status: 'waiting',
      target: { branch: 'feat/sesiones-uuid', worktree: 'core-sesiones' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: 'a41c9e2',
      pending: {
        kind: 'question',
        at: now - 2 * MIN,
        title: '¿Cómo migro las sesiones existentes?',
        question: 'Hay 18.400 sesiones activas. ¿Las migro en la misma migración o creo una tabla nueva y las copio en segundo plano?',
        options: [
          { id: 'inline', label: 'En la misma migración', detail: 'Más simple; bloquea la tabla unos segundos.' },
          { id: 'backfill', label: 'Tabla nueva y copia en segundo plano', detail: 'Sin cortes; dos despliegues.' },
        ],
      },
      attempts: [{ n: 1, status: 'running', startedAt: now - 26 * MIN, endedAt: null, summary: 'Esquema nuevo listo; esperando decisión.' }],
      events: [
        { at: now - 26 * MIN, text: 'Empezó el intento 1' },
        { at: now - 14 * MIN, text: 'Generó la migración 0042_sesiones_uuid' },
        { at: now - 2 * MIN, text: 'Pregunta cómo migrar los datos existentes' },
      ],
    },
    {
      id: 't-dependencia',
      projectId: 'p-web',
      hostId: 'h-studio',
      agent: 'codex',
      title: 'Cachear las llamadas de /pricing',
      status: 'waiting',
      target: { branch: 'perf/pricing-cache', worktree: 'web-pricing' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: '9be0711',
      pending: {
        kind: 'approval',
        at: now - 5 * MIN,
        title: 'Instalar una dependencia',
        action: 'npm install @tanstack/react-query@5',
        why: 'Para cachear y revalidar los precios sin escribir el caché a mano.',
        effects: ['Cambia package.json y package-lock.json', 'Descarga 1 paquete (39 kB)'],
      },
      attempts: [{ n: 1, status: 'running', startedAt: now - 12 * MIN, endedAt: null, summary: 'Pausado hasta la aprobación.' }],
      events: [
        { at: now - 12 * MIN, text: 'Empezó el intento 1' },
        { at: now - 5 * MIN, text: 'Pide permiso para instalar una dependencia' },
      ],
    },
    {
      id: 't-release',
      projectId: 'p-core',
      hostId: 'h-studio',
      agent: 'claude',
      title: 'Preparar la release 2.15',
      status: 'waiting',
      target: { branch: 'release/2.15', worktree: 'core' },
      policy: { level: 'elevated', label: 'Elevada · ramas protegidas' },
      headSha: '77d2f10',
      pending: {
        kind: 'approval',
        at: now - 9 * MIN,
        title: 'Empujar a una rama protegida',
        action: 'git push origin release/2.15',
        why: 'Etiqueta la versión y deja la rama lista para el pipeline de release.',
        effects: ['Publica 4 commits en release/2.15', 'Dispara el pipeline de release'],
      },
      attempts: [{ n: 1, status: 'running', startedAt: now - 40 * MIN, endedAt: null, summary: 'Changelog y versión listos.' }],
      events: [
        { at: now - 40 * MIN, text: 'Empezó el intento 1' },
        { at: now - 9 * MIN, text: 'Pide empujar a release/2.15 (política elevada)' },
      ],
    },
    {
      id: 't-avatar',
      projectId: 'p-web',
      hostId: 'h-studio',
      agent: 'lixbon',
      title: 'Recortar el avatar antes de subirlo',
      status: 'review',
      target: { branch: 'fix/avatar-recorte', worktree: 'web-avatar' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: 'c03d5aa',
      pending: {
        kind: 'review',
        at: now - 18 * MIN,
        title: 'Revisión lista',
        review: {
          baseSha: 'c03d5aa',
          summary: 'Recorta la imagen a cuadrado en el cliente y limita el lado a 512 px antes de subirla.',
          additions: 42,
          deletions: 10,
          files: [
            { path: 'src/account/AvatarPicker.jsx', additions: 31, deletions: 8 },
            { path: 'src/lib/image.js', additions: 9, deletions: 2 },
            { path: 'src/lib/image.test.js', additions: 2, deletions: 0 },
          ],
          checks: [
            { name: 'Pruebas', state: 'passed' },
            { name: 'Lint', state: 'passed' },
            { name: 'Build', state: 'passed' },
          ],
          risks: [],
        },
      },
      attempts: [{ n: 1, status: 'done', startedAt: now - 52 * MIN, endedAt: now - 18 * MIN, summary: '3 archivos; pruebas en verde.' }],
      events: [
        { at: now - 52 * MIN, text: 'Empezó el intento 1' },
        { at: now - 18 * MIN, text: 'Terminó y dejó la revisión' },
      ],
    },
    {
      id: 't-tema',
      projectId: 'p-mobile',
      hostId: 'h-laptop',
      agent: 'claude',
      title: 'Tema claro en los ajustes',
      status: 'review',
      target: { branch: 'feat/ajustes-claro', worktree: 'mobile-tema' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: 'e5f6081',
      pending: {
        kind: 'review',
        at: now - 50 * MIN,
        title: 'Revisión lista',
        review: {
          baseSha: 'b19a3c4',
          summary: 'Ajusta los colores de Ajustes al tema claro y corrige el contraste de los interruptores.',
          additions: 64,
          deletions: 21,
          files: [
            { path: 'src/screens/SettingsScreen.js', additions: 40, deletions: 15 },
            { path: 'src/theme.js', additions: 24, deletions: 6 },
          ],
          checks: [
            { name: 'Pruebas', state: 'passed' },
            { name: 'Build', state: 'passed' },
          ],
          risks: [],
        },
      },
      attempts: [{ n: 1, status: 'done', startedAt: now - 80 * MIN, endedAt: now - 50 * MIN, summary: 'Revisión generada; luego llegó un commit nuevo.' }],
      events: [
        { at: now - 80 * MIN, text: 'Empezó el intento 1' },
        { at: now - 50 * MIN, text: 'Terminó y dejó la revisión' },
        { at: now - 20 * MIN, text: 'Llegó el commit e5f6081 a la rama' },
      ],
    },
    {
      id: 't-cobros',
      projectId: 'p-core',
      hostId: 'h-studio',
      agent: 'codex',
      title: 'Reintentos idempotentes en los cobros',
      status: 'review',
      target: { branch: 'feat/cobros-idempotentes', worktree: 'core-cobros' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: '3aa90d1',
      pending: {
        kind: 'review',
        at: now - 35 * MIN,
        title: 'Revisión lista',
        review: {
          baseSha: '3aa90d1',
          summary: 'Añade claves de idempotencia a los cobros, una migración y reintentos con espera exponencial.',
          additions: 1012,
          deletions: 228,
          files: Array.from({ length: 31 }, (_, i) =>
            i === 0
              ? { path: 'migrations/0043_idempotency_keys.sql', additions: 48, deletions: 0 }
              : { path: `src/billing/part_${String(i).padStart(2, '0')}.rs`, additions: 31, deletions: 7 },
          ),
          checks: [
            { name: 'Pruebas', state: 'passed' },
            { name: 'Build', state: 'passed' },
            { name: 'E2E de cobros', state: 'pending' },
          ],
          risks: ['Toca una migración', 'Cambia el flujo de cobro'],
        },
      },
      attempts: [{ n: 1, status: 'done', startedAt: now - 2 * H, endedAt: now - 35 * MIN, summary: '31 archivos; E2E de cobros aún corriendo.' }],
      events: [
        { at: now - 2 * H, text: 'Empezó el intento 1' },
        { at: now - 35 * MIN, text: 'Terminó y dejó la revisión' },
      ],
    },
    {
      id: 't-flaky',
      projectId: 'p-web',
      hostId: 'h-studio',
      agent: 'lixbon',
      title: 'Arreglar el test intermitente del checkout',
      status: 'failed',
      target: { branch: 'fix/checkout-flaky', worktree: 'web-checkout' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: '1f0b8de',
      pending: null,
      attempts: [
        { n: 1, status: 'failed', startedAt: now - 5 * H, endedAt: now - 4.5 * H, summary: 'El test siguió fallando 2 de 10 veces.' },
        { n: 2, status: 'failed', startedAt: now - 4 * H, endedAt: now - 3 * H, summary: 'Bajó a 1 de 10, pero sigue fallando.' },
      ],
      events: [
        { at: now - 4 * H, text: 'Empezó el intento 2' },
        { at: now - 3 * H, text: 'El intento 2 terminó con 1 fallo de 10' },
      ],
    },
    {
      // Host sin conexión: la tarea no se marca como fallida, se muestra el
      // último dato que llegó y cuándo.
      id: 't-bench',
      projectId: 'p-core',
      hostId: 'h-ci',
      agent: 'codex',
      title: 'Benchmark del parser de eventos',
      status: 'running',
      target: { branch: 'perf/parser-eventos', worktree: 'core-bench' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: '6d1e0f3',
      pending: null,
      attempts: [{ n: 1, status: 'running', startedAt: now - 4 * H, endedAt: null, summary: 'Midiendo con 1 M de eventos.' }],
      events: [
        { at: now - 4 * H, text: 'Empezó el intento 1' },
        { at: now - 3 * H, text: 'Último dato: 62 % de las mediciones' },
      ],
    },
    {
      id: 't-docs',
      projectId: 'p-web',
      hostId: 'h-studio',
      agent: 'claude',
      title: 'Documentar el endpoint de facturas',
      status: 'running',
      target: { branch: 'docs/facturas', worktree: 'web-docs' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: '0c7e4b9',
      pending: null,
      attempts: [{ n: 1, status: 'running', startedAt: now - 7 * MIN, endedAt: null, summary: 'Escribiendo los ejemplos de respuesta.' }],
      events: [
        { at: now - 7 * MIN, text: 'Empezó el intento 1' },
        { at: now - 40 * S, text: 'Editó docs/api/invoices.md' },
      ],
    },
    {
      id: 't-icons',
      projectId: 'p-mobile',
      hostId: 'h-laptop',
      agent: 'codex',
      title: 'Iconos adaptativos para Android 16',
      status: 'running',
      target: { branch: 'feat/iconos-a16', worktree: 'mobile-iconos' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: '58e1c2d',
      pending: null,
      attempts: [{ n: 1, status: 'running', startedAt: now - 22 * MIN, endedAt: null, summary: 'Generando las capas del icono.' }],
      events: [
        { at: now - 22 * MIN, text: 'Empezó el intento 1' },
        { at: now - 5 * MIN, text: 'Generó assets/adaptive-icon.png' },
      ],
    },
    {
      id: 't-readme',
      projectId: 'p-core',
      hostId: 'h-studio',
      agent: 'lixbon',
      title: 'Actualizar el README del core',
      status: 'done',
      target: { branch: 'docs/readme-core', worktree: 'core-readme' },
      policy: { level: 'standard', label: 'Estándar' },
      headSha: 'f00ba12',
      pending: null,
      attempts: [{ n: 1, status: 'done', startedAt: now - 70 * MIN, endedAt: now - 61 * MIN, summary: 'Integrada.' }],
      events: [{ at: now - 61 * MIN, text: 'Integrada en master' }],
    },
  ];

  // Algunos avisos ya leídos apuntan a tareas que siguen pidiendo atención, y
  // uno sin leer es de una tarea terminada: atención ≠ no leído.
  const notifications = [
    { id: 'n1', kind: 'question', taskId: 't-migracion', at: now - 2 * MIN, read: false },
    { id: 'n2', kind: 'approval', taskId: 't-dependencia', at: now - 5 * MIN, read: true },
    { id: 'n3', kind: 'approval', taskId: 't-release', at: now - 9 * MIN, read: false },
    { id: 'n4', kind: 'review', taskId: 't-avatar', at: now - 18 * MIN, read: true },
    { id: 'n5', kind: 'review', taskId: 't-cobros', at: now - 35 * MIN, read: true },
    { id: 'n6', kind: 'done', taskId: 't-readme', at: now - 61 * MIN, read: false },
    { id: 'n7', kind: 'failed', taskId: 't-flaky', at: now - 3 * H, read: true },
  ];

  // Uso por proveedor (LXO-208): cada cifra dice de cuándo es.
  const usage = [
    { id: 'claude', label: 'Claude Code', window: 'Sesión de 5 h', percent: 72, resetAt: now + 94 * MIN, syncedAt: now - 30 * S },
    { id: 'codex', label: 'Codex', window: 'Semana', percent: 35, resetAt: now + 3 * 24 * H, syncedAt: now - 30 * S },
    { id: 'lixbon', label: 'Lixbon', window: 'Sesión de 4 h', percent: 91, resetAt: now + 41 * MIN, syncedAt: now - 30 * S },
  ];

  return { hosts, projects, tasks, notifications, usage };
}
