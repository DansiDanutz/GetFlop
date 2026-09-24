/**
 * Realtime fan-out. Rooms:
 *   table:<tableId>   everyone viewing a table (players, dealer, TV)
 *   club:<clubId>     every member socket of a club
 *   staff:<clubId>    owner/manager/inspector sockets of a club
 *   user:<userId>     one user's sockets
 *   tv:<sessionId>    a paired TV
 */
export interface Events {
  emit(room: string, event: string, payload: unknown): void;
}

export interface RecordedEvent {
  readonly room: string;
  readonly event: string;
  readonly payload: unknown;
}

/** Test double that records every emitted event. */
export class RecordingEvents implements Events {
  readonly log: RecordedEvent[] = [];
  emit(room: string, event: string, payload: unknown): void {
    this.log.push({ room, event, payload });
  }
  named(event: string): RecordedEvent[] {
    return this.log.filter((e) => e.event === event);
  }
  clear(): void {
    this.log.length = 0;
  }
}

export const rooms = {
  table: (id: string) => `table:${id}`,
  club: (id: string) => `club:${id}`,
  staff: (id: string) => `staff:${id}`,
  user: (id: string) => `user:${id}`,
  tv: (id: string) => `tv:${id}`,
};
