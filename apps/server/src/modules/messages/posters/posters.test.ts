import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../../db/schema/index.js';
import { grantRole, setupClub, type ClubFixture } from '../../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../../test/harness.js';
import { scoped } from '../test-helpers.js';

let env: TestEnv;
let club: ClubFixture;

beforeEach(async () => {
  env = await createTestEnv();
  club = await setupClub(env, { players: ['alice'], pointsEach: 0, clubName: 'Sharks & Co' });
});
afterEach(async () => { await env.close(); });

const welcome = { kind: 'welcome', firstLine: 'Welcome!', message: 'Predict the flop with us', extraLine: 'Every Friday from 21:00' };
const owner = () => scoped(club.owner, club.clubId);

describe('posters', () => {
  it('are for the owner only', async () => {
    await grantRole(env, club.clubId, club.players[0]!.userId, 'manager');
    expect(errCode(await scoped(club.players[0]!, club.clubId).post('/posters/preview', { poster: welcome })))
      .toBe('posters.owner_only');
  });

  it('validate the fields', async () => {
    expect(errCode(await owner().post('/posters/preview', {}))).toBe('posters.invalid');
    expect(errCode(await owner().post('/posters/preview', { poster: { kind: 'welcome', firstLine: '' , message: 'x' } }))).toBe('posters.invalid');
    expect(errCode(await owner().post('/posters/preview', { poster: { kind: 'tournament', name: 'Cup' } }))).toBe('posters.invalid');
    expect(errCode(await owner().post('/posters/preview', { poster: { ...welcome, message: 'x'.repeat(301) } }))).toBe('posters.invalid');
    expect(errCode(await owner().post('/posters/preview', { poster: welcome, lang: 'it' }))).toBe('posters.invalid');
  });

  it('preview an A4 SVG with the club QR and escaped text', async () => {
    const { svg } = ok(await owner().post('/posters/preview', { poster: welcome, lang: 'el' }));
    expect(svg).toContain('viewBox="0 0 2480 3508"');
    expect(svg).toContain('Sharks &amp; Co');
    expect(svg).toContain(`ID λέσχης ${club.publicId}`);
    expect(svg).toMatch(/<path d="M[\d.]+ [\d.]+h/);
    const t = ok(await owner().post('/posters/preview', { poster: { kind: 'tournament', name: '<Cup>', when: 'Sat 20:00', secondLine: 'Free entry' } }));
    expect(t.svg).toContain('&lt;Cup&gt;');
    expect(t.svg).toContain('TOURNAMENT');
  });

  it('render a PNG and a print-ready PDF', async () => {
    const png = ok(await owner().post('/posters/render', { poster: welcome, format: 'png' }));
    expect(png).toMatchObject({ mimeType: 'image/png', filename: 'sharks-co-welcome-poster.png' });
    const pngBytes = Buffer.from(png.base64, 'base64');
    expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');
    expect(pngBytes.readUInt32BE(16)).toBe(2480);
    expect(pngBytes.readUInt32BE(20)).toBe(3508);

    const pdf = ok(await owner().post('/posters/render', { poster: welcome }));
    expect(pdf.mimeType).toBe('application/pdf');
    const text = Buffer.from(pdf.base64, 'base64').toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('/Width 2480 /Height 3508');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  }, 30_000);

  it('email the PDF to the owner, or explain why not', async () => {
    const res = ok(await owner().post('/posters/email', { poster: welcome }));
    expect(res).toEqual({ sentTo: 'owner@example.test' });
    const mail = env.mailer.lastTo('owner@example.test');
    expect(mail?.attachments?.[0]).toMatchObject({ contentType: 'application/pdf', filename: 'sharks-co-welcome-poster.pdf' });

    const spy = vi.spyOn(env.mailer, 'send').mockRejectedValueOnce(new Error('smtp down'));
    expect(errCode(await owner().post('/posters/email', { poster: welcome }))).toBe('posters.email_failed');
    spy.mockRestore();

    await env.db.update(users).set({ email: null }).where(eq(users.id, club.owner.userId));
    expect(errCode(await owner().post('/posters/email', { poster: welcome }))).toBe('posters.no_email');
  }, 30_000);
});
