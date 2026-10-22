import { and, count, eq, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, rooms } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms as rt } from '../../realtime/events.js';
import { assertName } from '../auth/validation.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { levelOf, nextLevel } from '../commerce/levels.js';

/** The platform-managed room used by the Simulation module. */
export const SIMULATION_ROOM = 'Simulation';
const isReserved = (name: string) => name.toLowerCase() === SIMULATION_ROOM.toLowerCase();

export type RoomRow = typeof rooms.$inferSelect;

export async function listRooms(db: DbOrTx, clubId: string) {
  const rows = await db.select({
    id: rooms.id, name: rooms.name, createdAt: rooms.createdAt,
    tables: sql<number>`(select count(*)::int from ${clubTables} where ${clubTables.roomId} = ${rooms.id} and ${clubTables.status} <> 'archived')`,
  }).from(rooms).where(eq(rooms.clubId, clubId)).orderBy(rooms.createdAt);
  return rows.map((r) => ({ ...r, reserved: isReserved(r.name) }));
}

function assertRoomAccess(access: ClubAccess): void {
  if (!can(access, 'settings')) throw new AppError('club.settings_forbidden', 403);
}

const roomName = (name: string) => assertName(name, { min: 2, max: 40, code: 'room.name_invalid' });

async function assertUniqueName(db: DbOrTx, clubId: string, name: string, exceptId?: string): Promise<void> {
  const [clash] = await db.select({ id: rooms.id }).from(rooms)
    .where(and(eq(rooms.clubId, clubId), sql`lower(${rooms.name}) = lower(${name})`, ...(exceptId ? [ne(rooms.id, exceptId)] : []))).limit(1);
  if (clash) throw new AppError('room.name_taken', 409);
}

async function findRoom(db: DbOrTx, clubId: string, roomId: string): Promise<RoomRow> {
  const [room] = await db.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.clubId, clubId))).limit(1);
  if (!room) throw new AppError('room.not_found', 404);
  if (isReserved(room.name)) throw new AppError('room.reserved', 403);
  return room;
}

const regularRooms = (list: readonly { name: string }[]) => list.filter((r) => !isReserved(r.name));

function emitRooms(ctx: AppContext, clubId: string): void {
  ctx.events.emit(rt.staff(clubId), 'floor:changed', { clubId, rooms: true });
}

/** One room per club (older clubs keep extra rooms but cannot add more), within the Level's room capacity. */
export async function createRoom(ctx: AppContext, access: ClubAccess, input: { name: string }) {
  assertRoomAccess(access);
  const clubId = access.club.id;
  const name = roomName(input.name);
  if (isReserved(name)) throw new AppError('room.reserved', 403);
  const existing = regularRooms(await listRooms(ctx.db, clubId));
  if (existing.length >= 1) throw new AppError('room.one_per_club', 409);
  const level = levelOf(access.club.level);
  if (existing.length >= level.rooms) {
    const code = can(access, 'billing') ? 'commerce.capacity_rooms_billing' : 'commerce.capacity_rooms_staff';
    throw new AppError(code, 409, { used: existing.length, limit: level.rooms, nextLevel: nextLevel(level.code)?.name ?? '' });
  }
  await assertUniqueName(ctx.db, clubId, name);
  const [room] = await ctx.db.insert(rooms).values({ clubId, name }).returning();
  emitRooms(ctx, clubId);
  return { room: room! };
}

export async function renameRoom(ctx: AppContext, access: ClubAccess, roomId: string, input: { name: string }) {
  assertRoomAccess(access);
  const clubId = access.club.id;
  await findRoom(ctx.db, clubId, roomId);
  const name = roomName(input.name);
  if (isReserved(name)) throw new AppError('room.reserved', 403);
  await assertUniqueName(ctx.db, clubId, name, roomId);
  const [room] = await ctx.db.update(rooms).set({ name }).where(eq(rooms.id, roomId)).returning();
  emitRooms(ctx, clubId);
  return { room: room! };
}

export async function deleteRoom(ctx: AppContext, access: ClubAccess, roomId: string) {
  assertRoomAccess(access);
  const clubId = access.club.id;
  await ctx.db.transaction(async (tx) => {
    await findRoom(tx, clubId, roomId);
    const [tables] = await tx.select({ n: count() }).from(clubTables)
      .where(and(eq(clubTables.roomId, roomId), ne(clubTables.status, 'archived')));
    if ((tables?.n ?? 0) > 0) throw new AppError('room.has_tables', 409);
    if (regularRooms(await listRooms(tx, clubId)).length <= 1) throw new AppError('room.last', 409);
    await tx.update(clubTables).set({ roomId: null }).where(eq(clubTables.roomId, roomId));
    await tx.delete(rooms).where(eq(rooms.id, roomId));
  });
  emitRooms(ctx, clubId);
  return { deleted: roomId };
}
