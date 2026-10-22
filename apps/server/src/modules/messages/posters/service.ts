import type { Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../../context.js';
import { AppError } from '../../../http/errors.js';
import type { AuthUser } from '../../auth/session.js';
import { clubIdFrom, loadClubAccess, type ClubAccess } from '../../clubs/access.js';
import { POSTER_LABELS, type PosterLang } from './labels.js';
import { pdfFromRaster, rasterize } from './render.js';
import { posterSvg, type PosterInput } from './svg.js';

const line = (max: number) => z.string().trim().max(max);

const posterShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('welcome'), firstLine: line(60).min(1), message: line(300).min(1), extraLine: line(80).optional() }),
  z.object({
    kind: z.literal('tournament'), tournamentId: z.string().max(64).nullish(),
    name: line(60).min(1), when: line(60).min(1), secondLine: line(80).optional(),
  }),
]);

const requestShape = z.object({
  poster: posterShape,
  lang: z.enum(['en', 'el']).default('en'),
  format: z.enum(['pdf', 'png']).default('pdf'),
});

export interface PosterRequest { readonly poster: PosterInput; readonly lang: PosterLang; readonly format: 'pdf' | 'png' }

export function parsePosterRequest(body: unknown): PosterRequest {
  const parsed = requestShape.safeParse(body);
  if (!parsed.success) throw new AppError('posters.invalid', 400);
  return parsed.data;
}

/** Posters are the owner's alone (not managers, not platform admins acting from outside). */
export async function requireOwner(ctx: AppContext, req: Request, user: AuthUser): Promise<ClubAccess> {
  const access = await loadClubAccess(ctx.db, user, clubIdFrom(req, user));
  if (!access.roles.includes('owner')) throw new AppError('posters.owner_only', 403);
  return access;
}

export function buildSvg(ctx: AppContext, access: ClubAccess, request: PosterRequest): string {
  const inviteUrl = `${ctx.config.publicAppUrl.replace(/\/$/, '')}/c/${access.club.publicId}`;
  return posterSvg(request.poster, { name: access.club.name, publicId: access.club.publicId, inviteUrl }, POSTER_LABELS[request.lang]);
}

export interface PosterFile { readonly filename: string; readonly mimeType: string; readonly content: Buffer }

function fileStem(access: ClubAccess, poster: PosterInput): string {
  const slug = access.club.name.normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'club';
  return `${slug}-${poster.kind}-poster`;
}

export function renderPoster(ctx: AppContext, access: ClubAccess, request: PosterRequest): PosterFile {
  const raster = rasterize(buildSvg(ctx, access, request));
  const stem = fileStem(access, request.poster);
  if (request.format === 'png') return { filename: `${stem}.png`, mimeType: 'image/png', content: raster.png };
  return { filename: `${stem}.pdf`, mimeType: 'application/pdf', content: pdfFromRaster(raster, `${access.club.name} poster`) };
}

/** "Email it to me": the PDF goes to the owner's account email. */
export async function emailPoster(ctx: AppContext, access: ClubAccess, request: PosterRequest): Promise<{ sentTo: string }> {
  const to = access.user.email;
  if (!to) throw new AppError('posters.no_email', 400);
  const file = renderPoster(ctx, access, { ...request, format: 'pdf' });
  const labels = POSTER_LABELS[request.lang];
  try {
    await ctx.mailer.send({
      to, subject: labels.emailSubject, text: labels.emailText,
      attachments: [{ filename: file.filename, contentType: file.mimeType, content: file.content }],
    });
  } catch (err) {
    ctx.logger.error('Poster email failed', err);
    throw new AppError('posters.email_failed', 502);
  }
  return { sentTo: to };
}
