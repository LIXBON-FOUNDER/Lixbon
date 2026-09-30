const pct = (n) => `${Math.round(n)}%`;
const join = (...parts) => parts.filter(Boolean).join(' · ');

function windowRow(label, w) {
  if (!w || w.percent == null) return null;
  const reset = w.resetAt ? new Date(w.resetAt * 1000).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return { label, detail: join(`${pct(w.percent)} usado`, reset && `se renueva ${reset}`), tone: w.percent >= 90 ? 'bad' : w.percent >= 70 ? 'warn' : 'ok' };
}

function rowsOf(card, commands) {
  if (card.status) {
    const s = card.status;
    return [
      { label: 'Versión', detail: s.version },
      { label: 'Modelo', detail: s.model },
      { label: 'Modo', detail: join(s.mode, s.effort && `esfuerzo ${s.effort}`) },
      { label: 'Carpeta', detail: s.cwd },
      { label: 'Cuenta', detail: join(s.account?.email, s.account?.subscriptionType) },
      { label: 'MCP', detail: s.mcp?.length ? s.mcp.map((m) => m.name).join(', ') : 'ninguno' },
    ].filter((r) => r.detail);
  }
  if (card.cost) {
    const c = card.cost;
    const ctx = c.context?.window ? `${Math.round(c.context.used / 1000)}k de ${Math.round(c.context.window / 1000)}k tokens` : '';
    return [
      { label: 'Gasto de la sesión', detail: `$${Number(c.usd || 0).toFixed(2)}` },
      ctx && { label: 'Contexto', detail: `${ctx} (${pct((c.context.used / c.context.window) * 100)})` },
      windowRow('Cupo de 5 horas', c.session),
      windowRow('Cupo semanal', c.week),
      c.plan && { label: 'Plan', detail: c.plan },
    ].filter(Boolean);
  }
  if (card.help) return commands.map((c) => ({ label: `/${c.name}`, detail: c.description }));
  if (card.skills) return card.skills.map((s) => ({ label: s.name, detail: join(s.desc, s.source) }));
  if (card.mcp) return card.mcp.map((s) => ({ label: s.name, detail: join(s.status, s.scope, s.kind), tone: s.tone }));
  if (card.permissions) {
    const p = card.permissions;
    const tone = { allow: 'ok', ask: 'warn', deny: 'bad' };
    const kind = { allow: 'Permitir', ask: 'Preguntar', deny: 'Denegar' };
    return [
      { label: 'Modo', detail: p.mode || p.defaultMode?.mode },
      ...p.rules.map((r) => ({ label: kind[r.kind], detail: join(r.rule, r.scope), tone: tone[r.kind] })),
      ...p.dirs.map((d) => ({ label: 'Carpeta extra', detail: join(d.dir, d.scope) })),
    ].filter((r) => r.detail);
  }
  if (card.hooks) {
    const rows = card.hooks.rows.map((h) => ({ label: h.event, detail: join(h.matcher, h.command, h.scope) }));
    return card.hooks.disabled ? [{ label: 'Hooks desactivados', detail: 'disableAllHooks', tone: 'warn' }, ...rows] : rows;
  }
  if (card.memory) {
    return card.memory.map((m) => ({
      label: m.scope,
      detail: m.exists ? join(m.path, `${m.lines} líneas`, `~${m.tokens.toLocaleString('es')} tokens`) : join(m.path, 'no existe'),
      tone: m.exists ? 'ok' : 'off',
    }));
  }
  if (card.doctor) return card.doctor.map((d) => ({ label: d.label, detail: d.detail, tone: d.tone }));
  return null;
}

// Las tarjetas de comando del IDE son componentes; el móvil las recibe
// resumidas en filas (o el texto que devolvió Claude Code).
export function remoteCard(card, commands = []) {
  const rows = rowsOf(card, commands);
  return {
    name: card.name,
    args: card.args || '',
    rows: rows || [],
    text: rows ? (rows.length ? '' : 'Nada configurado.') : String(card.output || '').trim() || 'Hecho.',
  };
}
