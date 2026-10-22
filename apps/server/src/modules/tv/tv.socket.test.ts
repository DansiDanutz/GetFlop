import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { createTestEnv, ok, type TestEnv } from '../../test/harness.js';
import { socketExtensions } from '../jobs.js';
import { createIo } from '../../realtime/io.js';
import { openCashTable, pairCash, type TvSetup } from './tv.fixtures.js';

let env: TestEnv;
let io: Server;
let s: TvSetup;
const sockets: Socket[] = [];

beforeEach(async () => {
  env = await createTestEnv({ bettingTimerSeconds: 30 });
  io = createIo(env.server, env.ctx, socketExtensions);
  // Relay every recorded event to the real socket server as SocketEvents does in production.
  const record = env.events.emit.bind(env.events);
  env.events.emit = (room, event, payload) => {
    record(room, event, payload);
    io.to(room).emit(event, payload);
  };
  s = await openCashTable(env);
});
afterEach(async () => {
  sockets.splice(0).forEach((c) => c.disconnect());
  io.close();
  await env.close();
});

function tvSocket(displayToken: string): Socket {
  const socket = connect(env.url, { auth: { displayToken }, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(socket);
  return socket;
}

const once = <T>(socket: Socket, event: string, ms = 5_000) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, (payload: T) => { clearTimeout(timer); resolve(payload); });
});

describe('TV socket', () => {
  it('a paired TV receives the hand events of its table', async () => {
    const token = await pairCash(env, s.owner, s.tableId);
    const socket = tvSocket(token);
    const ready = await once<{ kind: string; targetId: string }>(socket, 'tv:ready');
    expect(ready).toMatchObject({ kind: 'cash', targetId: s.tableId });

    const started = once<{ handNumber: number }>(socket, 'hand:started');
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    expect((await started).handNumber).toBe(1);

    const closed = once(socket, 'hand:betting-closed');
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/no-more-bets`));
    await closed;

    const revealed = once<{ card1: string }>(socket, 'hand:flop-revealed');
    const settled = once(socket, 'hand:settled');
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
    expect((await revealed).card1).toBe('Qc');
    await settled;
  });

  it('a TV is not put in user, club or staff rooms', async () => {
    const token = await pairCash(env, s.owner, s.tableId);
    const socket = tvSocket(token);
    await once(socket, 'tv:ready');
    const joined = [...(io.sockets.sockets.values())].find((x) => x.data.tv)!;
    expect([...joined.rooms].filter((r) => r !== joined.id).sort()).toEqual([`table:${s.tableId}`, `tv:${joined.data.tv.sessionId}`]);
  });

  it('refuses an unknown or expired display token', async () => {
    const socket = tvSocket('bogus');
    const err = await once<Error>(socket, 'connect_error');
    expect(err.message).toBe('tv.display_expired');
  });

  it('revoking the session disconnects the TV', async () => {
    const token = await pairCash(env, s.owner, s.tableId);
    const socket = tvSocket(token);
    await once(socket, 'tv:ready');
    const { sessions } = ok(await s.owner.get(`/api/tv/sessions?kind=cash&targetId=${s.tableId}`));
    const revoked = once(socket, 'tv:revoked');
    const gone = once(socket, 'disconnect');
    ok(await s.owner.delete(`/api/tv/sessions/${sessions[0].id}`));
    await revoked;
    await gone;
  });
});
