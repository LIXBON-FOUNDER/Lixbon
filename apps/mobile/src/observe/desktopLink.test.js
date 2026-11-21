import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopLinkController, preparedDesktopLink, verifiedDesktopLink } from './desktopLink.js';
import { createCoreLink } from './link.js';

const result = (source = {}, overrides = {}) => {
  const target = { project_id: 'p1', task_id: 't1', attempt_id: 't1-a1', view: 'review', file: null, line: null, revision: 'abcdef1', ...source };
  const canonical = `lixbon://project/${target.project_id}/task/${target.task_id}/attempt/${target.attempt_id}?view=${target.view}&revision=${target.revision}`;
  return { open_status: 'opened', link: { v: 1, status: 'ready', canonical, target, revision: { requested: target.revision, current: target.revision, state: 'current' } }, ...overrides };
};

describe('LXO-50 canonical Desktop links', () => {
  it('only a transport outage preserves a prepared URL; deletion or lost authorization clears it', () => {
    const previous = { url: 'lixbon://project/p1' };
    assert.equal(preparedDesktopLink(previous, { value: null, code: 'offline' }), previous);
    for (const code of ['link_not_found', 'unauthorized', 'link_unauthorized', 'link_stale', 'invalid_response']) {
      assert.equal(preparedDesktopLink(previous, { value: null, code }), null);
    }
  });
  it('keeps the exact Attempt, view and revision from Core', () => {
    const data = result();
    assert.equal(verifiedDesktopLink(data, { attempt_id: 't1-a1', view: 'review', revision: 'abcdef1' }).url, data.link.canonical);
    assert.equal(verifiedDesktopLink(data, { attempt_id: 't9-a1' }), null);
    assert.equal(verifiedDesktopLink(data, { view: 'diff' }), null);
    assert.equal(verifiedDesktopLink(data, { revision: 'bbbbbbb' }), null);
  });
  it('rejects secrets, credentials, absolute or encoded paths and identity substitutions before copy/share', () => {
    for (const url of [
      'https://example.com', 'lixbon://user:secret@project/p1/task/t1/attempt/t1-a1',
      'lixbon://project/p1/task/t1/attempt/t1-a1?token=secret',
      'lixbon://project/p1/task/t1/attempt/t1-a1?view=review&revision=abcdef1&api_key=secret',
      'lixbon://project/p1/task/t1/attempt/t1-a1?view=review&view=diff',
      'lixbon://project/p1/task/t9/attempt/t9-a1?view=review&revision=abcdef1',
    ]) {
      const r = result(); r.link.canonical = url;
      assert.equal(verifiedDesktopLink(r, {}), null, url);
    }
    for (const file of ['/etc/passwd', 'C:/keys', '../key', 'src\\secret', '%2e%2e/key']) {
      const r = result({ file });
      assert.equal(verifiedDesktopLink(r, {}), null, file);
    }
  });
  it('a stale link is available to copy/share but never reported as opened', () => {
    const r = result(); r.link.status = 'stale'; r.open_status = 'stale';
    assert.equal(verifiedDesktopLink(r, {}).status, 'stale');
    r.open_status = 'opened';
    assert.equal(verifiedDesktopLink(r, {}), null);
  });
  it('preserves file/line with single encoding', () => {
    const r = result({ file: 'src/a b.rs', line: 9 });
    r.link.canonical += '&file=src%2Fa%20b.rs&line=9';
    assert.equal(verifiedDesktopLink(r, { file: 'src/a b.rs', line: 9 }).target.line, 9);
  });
  it('the relay pairs the new response by rid without turning it into transcript', async () => {
    let link;
    link = createCoreLink({ newRid: () => 'f6-1', send: async (request) => {
      assert.equal(request.action, 'core_desktop_link');
      assert.equal(link.handleEvent({ type: 'orch_core_desktop_link', rid: request.args.rid, protocol: 1, ok: true, ...result() }), true);
      return { ok: true };
    } });
    const response = await link.request('core_desktop_link', { attempt_id: 't1-a1' });
    assert.ok(verifiedDesktopLink(response.data, { attempt_id: 't1-a1' }));
    assert.equal(link.pendingCount, 0); link.close();
  });
  it('generation invalidation discards a response after changing target or host', async () => {
    let finish; const states = [];
    const controller = createDesktopLinkController({ publish: (s) => states.push(s), request: () => new Promise((r) => { finish = r; }) });
    const pending = controller.prepare({ attempt_id: 't1-a1' });
    controller.invalidate(); finish({ ok: true, data: result() });
    assert.equal(await pending, null); assert.deepEqual(states, []);
  });
  it('a newer request wins over a slow response', async () => {
    const pending = [], states = [];
    const controller = createDesktopLinkController({ publish: (s) => states.push(s), request: () => new Promise((r) => pending.push(r)) });
    const first = controller.prepare({ attempt_id: 't1-a1' });
    const second = controller.prepare({ attempt_id: 't2-a1' });
    pending[1]({ ok: true, data: result({ task_id: 't2', attempt_id: 't2-a1' }) }); await second;
    pending[0]({ ok: true, data: result() }); await first;
    assert.equal(states.length, 1); assert.equal(states[0].value.target.attempt_id, 't2-a1');
  });
  it('host disconnection and invalid responses report a code, never arbitrary host error content', async () => {
    const states = [];
    const controller = createDesktopLinkController({ publish: (s) => states.push(s), request: async () => ({ ok: false, transport: 'host_offline' }) });
    await controller.prepare({ task_id: 't1' });
    assert.deepEqual(states[0], { value: null, code: 'offline' });
    assert.equal(states.some((s) => s.navigation), false);
  });
});
