// lspClient.js — cliente JSON-RPC de un servidor de lenguaje.
//
// Rust hace de transporte (lsp_start/lsp_send/lsp_stop) y desenmarca el framing;
// aquí vive el protocolo: handshake, ciclo de vida del documento, peticiones y
// las respuestas a lo que el servidor nos pregunta a nosotros.
import { listen } from '@tauri-apps/api/event';
import { lspStart, lspSend, lspStop } from './tauri';

const REQUEST_TIMEOUT_MS = 20000;

// ── Rutas ↔ URIs ────────────────────────────────────────────────────────

/** `C:\a\b.py` → `file:///C:/a/b.py` */
export function pathToUri(path) {
  let s = String(path).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`; // Windows: la unidad va tras la barra
  return `file://${encodeURI(s)}`;
}

/** `file:///C:/a/b.py` → `C:\a\b.py` (o la ruta POSIX tal cual). */
export function uriToPath(uri) {
  let s = decodeURI(String(uri).replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1).replace(/\//g, '\\'); // Windows
  return s;
}

// ── Posiciones CodeMirror ↔ LSP ─────────────────────────────────────────
// LSP cuenta en unidades UTF-16 dentro de la línea, que es justo cómo indexa
// JavaScript sus cadenas: la conversión es directa.

export function posToLsp(state, pos) {
  const line = state.doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

export function lspToPos(state, p) {
  const doc = state.doc;
  const line = doc.line(Math.min(doc.lines, Math.max(1, (p?.line ?? 0) + 1)));
  return Math.min(line.to, line.from + Math.max(0, p?.character ?? 0));
}

// ── Cliente ─────────────────────────────────────────────────────────────

export class LspClient {
  /** @param server def de lspServers.js · @param rootPath carpeta de trabajo */
  constructor(server, rootPath) {
    this.server = server;
    this.rootPath = rootPath;
    this.id = server.id;

    this.capabilities = null;
    this.alive = false;
    this.seq = 0;
    this.pending = new Map(); // id JSON-RPC → {resolve, reject, timer}
    this.unlisten = [];
    this.docVersions = new Map(); // uri → versión

    this.onDiagnostics = null; // (path, diagnostics[]) — lo fija lspStore
    this.onExit = null;
  }

  async start() {
    // Escuchar ANTES de lanzar: si no, se pierden los primeros mensajes.
    this.unlisten = [
      await listen(`lsp:msg:${this.id}`, (e) => this._onMessage(e.payload)),
      await listen(`lsp:exit:${this.id}`, () => this._onExit()),
      await listen(`lsp:err:${this.id}`, (e) => {
        // stderr del servidor: solo interesa al depurar.
        console.debug(`[lsp:${this.id}]`, e.payload);
      }),
    ];

    try {
      await lspStart(this.id, this.server.command, this.server.args);
    } catch (e) {
      this._unlistenAll();
      throw e; // el binario no está: lspStore probará el siguiente candidato
    }
    this.alive = true;

    const result = await this.request('initialize', {
      processId: null,
      rootUri: pathToUri(this.rootPath),
      workspaceFolders: [{ uri: pathToUri(this.rootPath), name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: false },
          completion: {
            completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    });

    this.capabilities = result?.capabilities || {};
    this.notify('initialized', {});
    return this.capabilities;
  }

  // ── Transporte ────────────────────────────────────────────────────────

  _send(msg) {
    if (!this.alive) return Promise.resolve();
    return lspSend(this.id, JSON.stringify(msg)).catch(() => {
      this.alive = false; // el servidor murió entre medias
    });
  }

  notify(method, params) {
    return this._send({ jsonrpc: '2.0', method, params });
  }

  request(method, params) {
    if (!this.alive && method !== 'initialize') {
      return Promise.reject(new Error('El servidor de lenguaje no está vivo.'));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`El servidor no respondió a ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // marco corrupto: ignorarlo es más seguro que morir
    }

    // Respuesta a algo que pedimos nosotros.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'Error del servidor'));
      else p.resolve(msg.result);
      return;
    }

    // Petición DEL servidor: hay que contestarla siempre. Si no, servidores como
    // Pyright se quedan bloqueados esperando en el arranque.
    if (msg.id !== undefined && msg.method) {
      this._respond(msg);
      return;
    }

    // Notificación del servidor.
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = msg.params || {};
      this.onDiagnostics?.(uriToPath(uri), (diagnostics || []).map(fromLspDiagnostic));
    }
  }

  _respond(msg) {
    let result = null;
    if (msg.method === 'workspace/configuration') {
      // Un ajuste por cada item pedido: null = «usa tus valores por defecto».
      result = (msg.params?.items || []).map(() => null);
    } else if (msg.method === 'workspace/workspaceFolders') {
      result = [{ uri: pathToUri(this.rootPath), name: 'workspace' }];
    }
    // El resto (registerCapability, workDoneProgress/create…) se acepta con null.
    this._send({ jsonrpc: '2.0', id: msg.id, result });
  }

  _onExit() {
    this.alive = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('El servidor de lenguaje se cerró.'));
    }
    this.pending.clear();
    this.onExit?.();
  }

  _unlistenAll() {
    for (const un of this.unlisten) un();
    this.unlisten = [];
  }

  // ── Ciclo de vida del documento ───────────────────────────────────────

  didOpen(path, languageId, text) {
    const uri = pathToUri(path);
    this.docVersions.set(uri, 1);
    return this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  /** Sincronización completa: mandamos el documento entero. Es lo que declara
      nuestra capability y evita tener que traducir los rangos de CodeMirror. */
  didChange(path, text) {
    const uri = pathToUri(path);
    const version = (this.docVersions.get(uri) || 1) + 1;
    this.docVersions.set(uri, version);
    return this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didSave(path) {
    return this.notify('textDocument/didSave', {
      textDocument: { uri: pathToUri(path) },
    });
  }

  didClose(path) {
    const uri = pathToUri(path);
    this.docVersions.delete(uri);
    return this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  // ── Funciones de lenguaje ─────────────────────────────────────────────

  completion(path, position) {
    return this.request('textDocument/completion', {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  hover(path, position) {
    return this.request('textDocument/hover', {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  definition(path, position) {
    return this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  async stop() {
    this.alive = false;
    this._unlistenAll();
    try {
      await lspStop(this.id);
    } catch { /* ya estaba muerto */ }
  }
}

// ── Traducción de tipos LSP ─────────────────────────────────────────────

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/** Diagnostic de LSP (0-based) → el shape que ya usan lintExt y el panel. */
function fromLspDiagnostic(d) {
  return {
    line: (d.range?.start?.line ?? 0) + 1,
    col: (d.range?.start?.character ?? 0) + 1,
    endLine: (d.range?.end?.line ?? 0) + 1,
    endCol: (d.range?.end?.character ?? 0) + 1,
    severity: SEVERITY[d.severity] || 'warning',
    message: d.message || '',
    source: d.source || 'lsp',
  };
}
