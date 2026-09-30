// In-process publish/subscribe used to push live updates to browsers over Server-Sent Events.
// Channels: "lobby" (table list changes) and "table:<id>" (round opened/closed/settled/void, bet counts).

export type Listener = (event: string, data: unknown) => void;

export class Events {
  private channels = new Map<string, Set<Listener>>();

  subscribe(channel: string, fn: Listener): () => void {
    let set = this.channels.get(channel);
    if (!set) this.channels.set(channel, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.channels.delete(channel);
    };
  }

  publish(channel: string, event: string, data: unknown) {
    for (const fn of this.channels.get(channel) ?? []) {
      try { fn(event, data); } catch { /* a broken subscriber must not break the game */ }
    }
  }
}
