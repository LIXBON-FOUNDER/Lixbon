// lspStore.js — ciclo de vida de los servidores de lenguaje (A1).
//
// Un proceso por servidor (no por archivo): typescript-language-server sirve a
// la vez .ts, .tsx, .js y .jsx. Los clientes se lanzan perezosamente, al abrir
// el primer archivo de su lenguaje, y si el servidor no está instalado se
// instala solo (app-data de lixbon, sin permisos de admin ni tocar el PATH).
import { create } from 'zustand';
import { LspClient } from '../lib/lspClient';
import { serversFor, lspLanguageId, ALL_SERVERS } from '../lib/lspServers';
import { lspResolve, lspInstallNpm, lspInstallArchive, lspUninstallServer } from '../lib/tauri';
import { useAppStore } from './appStore';
import { useEditorStore, getLiveView } from './editorStore';
import { applyDiagnostics } from '../editor/lintExt';

const CHANGE_DEBOUNCE_MS = 400;

// Fuera del store (no son estado de React).
const clients = new Map();      // serverId → LspClient
const inFlight = new Map();     // serverId → Promise (evita arrancar/instalar dos veces)
const changeTimers = new Map(); // path → timeout
// Último diagnóstico publicado por archivo: el servidor los empuja cuando
// quiere, así que hay que recordarlos para el panel de Problemas.
const diagnosticsByPath = new Map();

/** 'missing' | 'installing' | 'starting' | 'ready' | 'failed' */
const setState = (set, get, id, patch) =>
  set({ servers: { ...get().servers, [id]: { ...get().servers[id], ...patch } } });

export const useLspStore = create((set, get) => ({
  enabled: (localStorage.getItem('lixbon_lsp') ?? 'true') === 'true',
  autoInstall: (localStorage.getItem('lixbon_lsp_autoinstall') ?? 'true') === 'true',
  // serverId → { state, path, error }
  servers: {},

  setEnabled: (enabled) => {
    localStorage.setItem('lixbon_lsp', enabled ? 'true' : 'false');
    set({ enabled });
    if (!enabled) get().stopAll();
  },

  setAutoInstall: (autoInstall) => {
    localStorage.setItem('lixbon_lsp_autoinstall', autoInstall ? 'true' : 'false');
    set({ autoInstall });
  },

  /** Cliente vivo para ese archivo, o null. No arranca nada. */
  clientFor: (fileName) => {
    for (const server of serversFor(fileName)) {
      const client = clients.get(server.id);
      if (client?.alive) return client;
    }
    return null;
  },

  /** Diagnósticos LSP conocidos de un archivo. */
  diagnosticsFor: (path) => diagnosticsByPath.get(path) || [],

  /** Comprueba qué servidores están ya disponibles (lo llama el panel de Ajustes). */
  refreshServers: async () => {
    for (const server of ALL_SERVERS) {
      // No pisar el estado de uno que está trabajando ahora mismo.
      const current = get().servers[server.id]?.state;
      if (current === 'installing' || current === 'starting' || current === 'ready') continue;
      const path = await lspResolve(server.id, server.bin).catch(() => null);
      setState(set, get, server.id, { state: path ? 'installed' : 'missing', path, error: '' });
    }
  },

  /** Instala un servidor. Devuelve la ruta del ejecutable, o null. */
  installServer: async (server) => {
    if (!server.install) return null;
    setState(set, get, server.id, { state: 'installing', error: '' });
    try {
      const path = server.install.kind === 'npm'
        ? await lspInstallNpm(server.id, server.install.package, server.bin)
        : await lspInstallArchive(server.id, server.install.url, server.bin);
      setState(set, get, server.id, { state: 'installed', path, error: '' });
      return path;
    } catch (e) {
      setState(set, get, server.id, { state: 'failed', error: String(e) });
      return null;
    }
  },

  reinstallServer: async (server) => {
    await lspUninstallServer(server.id).catch(() => {});
    clients.get(server.id)?.stop();
    clients.delete(server.id);
    return get().installServer(server);
  },

  /** Arranca (o reutiliza) el servidor del lenguaje de `fileName`, instalándolo
      si hace falta. null si no hay servidor para ese lenguaje o no se pudo. */
  ensureClient: async (fileName) => {
    if (!get().enabled) return null;

    const candidates = serversFor(fileName);
    if (!candidates.length) return null;

    const root = useAppStore.getState().workspaceRoot;
    if (!root) return null; // sin carpeta de trabajo no hay proyecto que analizar

    for (const server of candidates) {
      const live = clients.get(server.id);
      if (live?.alive) return live;

      // Otro archivo ya lo está preparando: engancharse a ese mismo intento.
      if (inFlight.has(server.id)) {
        const client = await inFlight.get(server.id);
        if (client) return client;
        continue;
      }

      const attempt = get()._launch(server, root);
      inFlight.set(server.id, attempt);
      const client = await attempt;
      inFlight.delete(server.id);
      if (client) return client;
    }
    return null;
  },

  /** Resuelve el binario (instalándolo si procede) y arranca el cliente. */
  _launch: async (server, root) => {
    let path = await lspResolve(server.id, server.bin).catch(() => null);

    if (!path) {
      if (!get().autoInstall || !server.install) {
        setState(set, get, server.id, { state: 'missing', path: null });
        return null;
      }
      path = await get().installServer(server);
      if (!path) return null;
    }

    setState(set, get, server.id, { state: 'starting', path, error: '' });

    const client = new LspClient({ ...server, command: path }, root);
    client.onDiagnostics = publish;
    client.onExit = () => {
      clients.delete(server.id);
      setState(set, get, server.id, { state: 'installed' }); // instalado, pero caído
    };

    try {
      await client.start();
      clients.set(server.id, client);
      setState(set, get, server.id, { state: 'ready', error: '' });
      return client;
    } catch (e) {
      console.warn(`[lsp] ${server.bin} no arrancó:`, e);
      await client.stop();
      setState(set, get, server.id, { state: 'failed', error: String(e) });
      return null;
    }
  },

  // ── Ciclo de vida del documento ─────────────────────────────────────

  openDoc: async (path, fileName, text) => {
    const client = await get().ensureClient(fileName);
    if (!client) return;
    client.didOpen(path, lspLanguageId(fileName), text);
  },

  /** Cambios del editor: se agrupan, no se manda uno por tecla. */
  changeDoc: (path, fileName, text) => {
    const client = get().clientFor(fileName);
    if (!client) return;
    clearTimeout(changeTimers.get(path));
    changeTimers.set(
      path,
      setTimeout(() => {
        changeTimers.delete(path);
        client.didChange(path, text);
      }, CHANGE_DEBOUNCE_MS),
    );
  },

  saveDoc: (path, fileName) => {
    get().clientFor(fileName)?.didSave(path);
  },

  closeDoc: (path, fileName) => {
    clearTimeout(changeTimers.get(path));
    changeTimers.delete(path);
    diagnosticsByPath.delete(path);
    get().clientFor(fileName)?.didClose(path);
  },

  stopAll: async () => {
    for (const client of clients.values()) await client.stop();
    clients.clear();
    inFlight.clear();
    diagnosticsByPath.clear();
    // Se conserva `servers` (qué está instalado no depende del workspace),
    // pero ninguno sigue corriendo.
    const servers = { ...get().servers };
    for (const id of Object.keys(servers)) {
      if (servers[id].state === 'ready' || servers[id].state === 'starting') {
        servers[id] = { ...servers[id], state: 'installed' };
      }
    }
    set({ servers });
  },
}));

/** Un servidor publicó diagnósticos. Si son del archivo a la vista, van al
    editor (subrayados) y al panel de Problemas. */
function publish(path, diagnostics) {
  diagnosticsByPath.set(path, diagnostics);

  const ed = useEditorStore.getState();
  if (ed.activePath !== path) return;

  applyDiagnostics(getLiveView(), diagnostics);

  const tab = ed.tabs.find((t) => t.path === path);
  // Import perezoso: problemsStore también mira aquí (ciclo).
  import('./problemsStore').then(({ useProblemsStore }) => {
    useProblemsStore.setState({
      diagnostics,
      path,
      name: tab?.name || '',
      running: false,
      error: '',
    });
  });
}
