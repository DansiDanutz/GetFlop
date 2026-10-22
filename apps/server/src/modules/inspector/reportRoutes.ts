import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { can, requireClub } from '../clubs/access.js';
import { analytics } from './analytics.js';
import { clubReport, clubReportCsv } from './clubReport.js';
import { liveBets, livePoints } from './live.js';
import { bigThresholdCents } from './queries.js';
import { handDetail, handResults, handsCsv, reportTables, shiftCsv, shiftReport, summaryReport } from './reports.js';
import { closeSession, openSession, sessionOverview } from './sessions.js';
import { clubTz, tzSchema } from './time.js';

const flag = z.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')]).optional()
  .transform((v) => v === '1' || v === 'true');
const id = z.string().max(64).optional();
const day = z.string().max(10).optional();

const periodQuery = z.object({ tableId: id, dateStart: day, dateEnd: day, all: flag, tz: tzSchema, format: z.enum(['json', 'csv']).optional() });

function sendCsv(res: Response, name: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(`﻿${body}`);
}

/** Reports: live feeds, hands, summary, shift report, club report, analytics, sessions. */
export function registerReportRoutes(api: Router, ctx: AppContext): void {
  const staff = (req: Request) => requireClub(ctx.db, req, currentUser(req), 'reports');

  api.get('/inspector/reports', handle(async (req) => {
    const access = await staff(req);
    const segments = ['live', 'hands', 'analytics', 'report', ...(can(access, 'settings') ? ['club'] : [])];
    return {
      segments, bigThresholdCents: bigThresholdCents(access.club), tz: clubTz(access.club.settings),
      tables: await reportTables(ctx, access.club.id),
    };
  }));

  api.get('/inspector/live/bets', handle(async (req) => {
    const q = z.object({ tz: tzSchema, tableId: id, wins: flag, big: flag }).parse(req.query);
    return liveBets(ctx, await staff(req), q);
  }));

  api.get('/inspector/live/points', handle(async (req) => {
    const q = z.object({ tz: tzSchema, actor: id }).parse(req.query);
    return livePoints(ctx, await staff(req), q);
  }));

  api.get('/inspector/results', handle(async (req, res) => {
    const q = periodQuery.parse(req.query);
    const result = await handResults(ctx, await staff(req), q);
    if (q.format === 'csv') return sendCsv(res, 'hands', handsCsv(result));
    return result;
  }));

  api.get('/inspector/hands/:handId', handle(async (req) => handDetail(ctx, await staff(req), String(req.params.handId))));

  api.get('/inspector/summary', handle(async (req) => summaryReport(ctx, await staff(req), periodQuery.parse(req.query))));

  api.get('/inspector/report', handle(async (req, res) => {
    const q = z.object({
      fromDatetime: z.string().max(40).optional(), toDatetime: z.string().max(40).optional(),
      tableIds: z.string().max(2_000).optional(), format: z.enum(['json', 'csv']).optional(),
    }).parse(req.query);
    const report = await shiftReport(ctx, await staff(req), q);
    if (q.format === 'csv') return sendCsv(res, 'shift-report', shiftCsv(report));
    return report;
  }));

  api.get('/inspector/club-report', handle(async (req, res) => {
    const q = periodQuery.parse(req.query);
    const access = await requireClub(ctx.db, req, currentUser(req), 'settings');
    const report = await clubReport(ctx, access, q);
    if (q.format === 'csv') return sendCsv(res, 'club-report', clubReportCsv(report));
    return report;
  }));

  api.get('/inspector/analytics', handle(async (req) => {
    const q = z.object({
      sessionId: id, from: z.string().max(40).optional(), to: z.string().max(40).optional(),
      includeBots: flag, source: z.enum(['auto', 'dealer']).optional(), dealerId: id,
    }).parse(req.query);
    return analytics(ctx, await staff(req), q);
  }));

  api.get('/inspector/session', handle(async (req) => sessionOverview(ctx, await staff(req))));
  api.post('/inspector/session/open', handle(async (req) => openSession(ctx, await staff(req))));
  api.post('/inspector/session/close', handle(async (req) => closeSession(ctx, await staff(req))));
}
