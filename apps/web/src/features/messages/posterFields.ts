import type { PosterInput } from './types';

/** The poster form keeps both kinds' fields so switching tabs loses nothing. */
export interface PosterFields {
  readonly kind: 'welcome' | 'tournament';
  readonly firstLine: string;
  readonly message: string;
  readonly extraLine: string;
  readonly tournamentId: string;
  readonly name: string;
  readonly when: string;
  readonly secondLine: string;
}

export function posterFromFields(f: PosterFields): PosterInput {
  if (f.kind === 'welcome') {
    return { kind: 'welcome', firstLine: f.firstLine.trim(), message: f.message.trim(), extraLine: f.extraLine.trim() };
  }
  return { kind: 'tournament', tournamentId: f.tournamentId || null, name: f.name.trim(), when: f.when.trim(), secondLine: f.secondLine.trim() };
}

/** Required: headline + message (welcome); name + day and time (tournament). */
export function posterIsComplete(f: PosterFields): boolean {
  return f.kind === 'welcome'
    ? Boolean(f.firstLine.trim() && f.message.trim())
    : Boolean(f.name.trim() && f.when.trim());
}
