import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirSocket } from './socket';

class FakeSocket {
  static abiertos = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.cerrado = false;
    FakeSocket.abiertos.push(this);
  }
  send() {}
  close() {
    this.cerrado = true;
  }
}

describe('socket de Team', () => {
  beforeEach(() => {
    FakeSocket.abiertos = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const abrir = (llave) => abrirSocket({ llave, cursores: () => ({}), alEvento: () => {}, alEstado: () => {} });

  it('cada reconexión usa el token vigente, no el del arranque', async () => {
    const tokens = ['lixbon_at_1', 'lixbon_at_2'];
    abrir(async () => tokens.shift());
    await vi.waitFor(() => expect(FakeSocket.abiertos).toHaveLength(1));
    expect(FakeSocket.abiertos[0].url).toContain('token=lixbon_at_1');

    FakeSocket.abiertos[0].onclose();
    await vi.advanceTimersByTimeAsync(31000);
    await vi.waitFor(() => expect(FakeSocket.abiertos).toHaveLength(2));
    expect(FakeSocket.abiertos[1].url).toContain('token=lixbon_at_2');
  });

  it('cerrar mientras se espera el token no deja una conexión abierta', async () => {
    let soltar;
    const s = abrir(() => new Promise((r) => { soltar = r; }));
    s.cerrar();
    soltar('lixbon_at_1');
    await vi.waitFor(() => expect(FakeSocket.abiertos).toHaveLength(1));
    expect(FakeSocket.abiertos[0].cerrado).toBe(true);
  });
});
