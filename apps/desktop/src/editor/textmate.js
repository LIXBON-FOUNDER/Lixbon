// textmate.js — resaltado con gramáticas TextMate de extensiones instaladas,
// para los lenguajes SIN parser lezer propio (languages.js gana siempre).
// vscode-textmate tokeniza línea a línea con estado (ruleStack), que encaja
// 1:1 con el modelo StreamParser de CodeMirror. El WASM de oniguruma
// (~160 KB gz) se carga perezosamente al abrir el primer archivo que lo
// necesita; si falla, se degrada a texto plano sin romper openFile.

import { StreamLanguage } from '@codemirror/language';
import { extReadFile } from '../lib/tauri';
import { installedGrammars, installedLanguages } from '../store/extStore';
import { SCOPE_TO_TAGS } from './scopeMap';

// tokenTable de StreamLanguage: nombre de estilo → tag lezer. Un estilo por
// entrada del mapa compartido, así los temas (lixbon o VSCode) pintan igual
// los tokens lezer y los TextMate.
const tokenTable = {};
SCOPE_TO_TAGS.forEach(([, tags], i) => {
  tokenTable[`tm${i}`] = tags[0];
});

// Resolución scope TextMate → nombre de estilo (prefijo más largo del mapa).
const styleCache = new Map();

function styleForScope(scope) {
  if (styleCache.has(scope)) return styleCache.get(scope);
  let best = null;
  let bestLen = 0;
  for (let i = 0; i < SCOPE_TO_TAGS.length; i++) {
    const key = SCOPE_TO_TAGS[i][0];
    if ((scope === key || scope.startsWith(key + '.')) && key.length > bestLen) {
      best = `tm${i}`;
      bestLen = key.length;
    }
  }
  styleCache.set(scope, best);
  return best;
}

/** Estilo para la lista de scopes de un token (el más específico gana). */
function styleForScopes(scopes) {
  for (let i = scopes.length - 1; i >= 1; i--) { // scopes[0] es el scope raíz
    const style = styleForScope(scopes[i]);
    if (style) return style;
  }
  return null;
}

// ── Carga perezosa de vscode-textmate + oniguruma (WASM) ────────────────

let vsctmModPromise = null;

async function loadVsctm() {
  if (!vsctmModPromise) {
    vsctmModPromise = (async () => {
      const [vsctm, oniguruma, { default: wasmUrl }] = await Promise.all([
        import('vscode-textmate'),
        import('vscode-oniguruma'),
        import('vscode-oniguruma/release/onig.wasm?url'),
      ]);
      const wasm = await fetch(wasmUrl).then((r) => r.arrayBuffer());
      await oniguruma.loadWASM(wasm);
      const onigLib = {
        createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s) => new oniguruma.OnigString(s),
      };
      const registry = new vsctm.Registry({
        onigLib: Promise.resolve(onigLib),
        loadGrammar: async (scopeName) => {
          const g = installedGrammars().find((x) => x.scopeName === scopeName);
          if (!g) return null;
          const raw = await extReadFile(g.extId, g.path);
          return vsctm.parseRawGrammar(raw, g.path);
        },
      });
      return { vsctm, registry };
    })().catch((e) => {
      vsctmModPromise = null; // permitir reintento
      throw e;
    });
  }
  return vsctmModPromise;
}

// ── Adaptador StreamParser ──────────────────────────────────────────────

const languageCache = new Map(); // scopeName → StreamLanguage | null

function tmStreamParser(vsctm, grammar, name) {
  return {
    name,
    startState: () => ({ ruleStack: vsctm.INITIAL, tokens: [], idx: 0 }),
    copyState: (s) => ({ ruleStack: s.ruleStack, tokens: [], idx: 0 }),
    token(stream, state) {
      if (stream.pos === 0) {
        // Línea nueva: tokenizarla completa con el estado heredado
        const res = grammar.tokenizeLine(stream.string, state.ruleStack, 500);
        state.tokens = res.tokens;
        state.ruleStack = res.ruleStack;
        state.idx = 0;
      }
      const tok = state.tokens[state.idx];
      if (!tok) {
        stream.skipToEnd();
        return null;
      }
      state.idx++;
      const end = Math.min(tok.endIndex, stream.string.length);
      stream.pos = Math.max(end, stream.pos + 1);
      return styleForScopes(tok.scopes);
    },
    blankLine(state) {
      const res = grammar.tokenizeLine('', state.ruleStack, 100);
      state.ruleStack = res.ruleStack;
    },
    tokenTable,
  };
}

async function grammarStreamLanguage(grammarInfo) {
  const { scopeName } = grammarInfo;
  if (languageCache.has(scopeName)) return languageCache.get(scopeName);
  try {
    const { vsctm, registry } = await loadVsctm();
    const grammar = await registry.loadGrammar(scopeName);
    if (!grammar) {
      languageCache.set(scopeName, null);
      return null;
    }
    const lang = StreamLanguage.define(
      tmStreamParser(vsctm, grammar, grammarInfo.language || scopeName),
    );
    languageCache.set(scopeName, lang);
    return lang;
  } catch (e) {
    console.warn('[textmate] No se pudo cargar la gramática', scopeName, e);
    languageCache.set(scopeName, null);
    return null;
  }
}

// ── Resolución archivo → gramática instalada ────────────────────────────

function extLanguageIdFor(lower) {
  for (const l of installedLanguages()) {
    if ((l.filenames || []).some((f) => String(f).toLowerCase() === lower)) return l.id;
    if ((l.extensions || []).some((e) => lower.endsWith(String(e).toLowerCase()))) return l.id;
  }
  return null;
}

/** Soporte TextMate para un archivo, desde las extensiones instaladas.
    Devuelve [StreamLanguage] o []. */
export async function textmateLanguageFor(fileName) {
  const lower = (fileName || '').toLowerCase();
  const grammars = installedGrammars();
  if (!grammars.length) return [];

  const langId = extLanguageIdFor(lower);
  let grammar = langId ? grammars.find((g) => g.language === langId) : null;
  if (!grammar) {
    // Respaldo: gramática cuyo id de lenguaje coincide con la extensión
    const ext = lower.includes('.') ? lower.split('.').pop() : lower;
    grammar = grammars.find((g) => g.language === ext) || null;
  }
  if (!grammar) return [];

  const lang = await grammarStreamLanguage(grammar);
  return lang ? [lang] : [];
}
