import { describe, expect, it } from 'vitest';
import { posterFromFields, posterIsComplete, type PosterFields } from './posterFields';

const base: PosterFields = {
  kind: 'welcome', firstLine: ' Welcome ', message: ' Hi ', extraLine: '', tournamentId: '', name: '', when: '', secondLine: '',
};

describe('poster fields', () => {
  it('builds a trimmed welcome poster', () => {
    expect(posterFromFields(base)).toEqual({ kind: 'welcome', firstLine: 'Welcome', message: 'Hi', extraLine: '' });
    expect(posterIsComplete(base)).toBe(true);
    expect(posterIsComplete({ ...base, message: '  ' })).toBe(false);
  });

  it('builds a tournament poster and needs a name and a time', () => {
    const f: PosterFields = { ...base, kind: 'tournament', name: 'Cup', when: 'Sat 20:00' };
    expect(posterFromFields(f)).toEqual({ kind: 'tournament', tournamentId: null, name: 'Cup', when: 'Sat 20:00', secondLine: '' });
    expect(posterIsComplete(f)).toBe(true);
    expect(posterIsComplete({ ...f, when: '' })).toBe(false);
    expect(posterFromFields({ ...f, tournamentId: 't1' })).toMatchObject({ tournamentId: 't1' });
  });
});
