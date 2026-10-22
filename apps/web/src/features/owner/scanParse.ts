/** What a scanned or pasted text is, for the desk "Scan QR" screen (03 §6). */
export type ScanTarget =
  | { kind: 'player'; code: string }
  | { kind: 'table'; joinCode: string }
  | { kind: 'invite'; publicId: string }
  | { kind: 'old' }
  | { kind: 'foreign' }
  | { kind: 'unused' }
  | { kind: 'empty' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PLAYER_CODE = new RegExp(`^${UUID}\\.\\d{9,11}\\.[A-Za-z0-9_-]{22}$`, 'i');
const OLD_CODE = new RegExp(`/inspector/player/${UUID}$`, 'i');

function sameApp(text: string, origin: string): boolean {
  try {
    return new URL(text).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function classifyScan(input: string, origin: string): ScanTarget {
  const text = input.trim();
  if (!text) return { kind: 'empty' };
  if (PLAYER_CODE.test(text)) return { kind: 'player', code: text };
  const pc = /\/pc\/([^/?#\s]+)$/.exec(text);
  if (pc && PLAYER_CODE.test(decodeURIComponent(pc[1]!))) return { kind: 'player', code: decodeURIComponent(pc[1]!) };
  if (OLD_CODE.test(text)) return { kind: 'old' };
  const join = /#\/join\/([A-Za-z0-9]{4,16})$/.exec(text);
  if (join) return { kind: 'table', joinCode: join[1]! };
  const invite = /\/c\/(\d{7})\/?$/.exec(text);
  if (invite) return { kind: 'invite', publicId: invite[1]! };
  return sameApp(text, origin) ? { kind: 'unused' } : { kind: 'foreign' };
}
