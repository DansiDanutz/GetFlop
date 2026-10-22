/** Shapes returned by the /messages and /posters endpoints. */

export const AUDIENCE_KEYS = [
  'all', 'active_7', 'active_30', 'inactive_30', 'new_14', 'ring_month', 'tourney_month', 'top_active', 'staff',
] as const;
export type AudienceKey = (typeof AUDIENCE_KEYS)[number];
export type AudienceChoice = AudienceKey | 'member';

export interface Audience { key: AudienceChoice; count: number; total: number; muted: number; capped: number }
export interface PlayerOption { userId: string; username: string; displayName: string }

export interface MessageAction { type: 'table' | 'tournament'; ref: string; label: string }
export interface TableTarget { id: string; name: string; hasDealer: boolean }
export interface TournamentTarget { id: string; name: string; startsAt: string | null; status: string }
export interface Targets { tables: TableTarget[]; tournaments: TournamentTarget[] }

export interface Suggestion {
  key: string;
  kind: 'comeback' | 'welcome' | 'tournament' | 'table';
  audience: AudienceKey;
  params: Record<string, string | number | null>;
  action?: MessageAction;
}

export interface SentStats { reached: number; opened: number; tapped: number; joined: number }
export interface SentMessage {
  id: string;
  audience: string;
  recipientName: string | null;
  title: string | null;
  body: string;
  hasPhoto: boolean;
  action: MessageAction | null;
  status: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  failReason: string | null;
  sendAt: string | null;
  sentAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  authorName: string;
  recipientCount: number;
  mutedCount: number;
  cappedCount: number;
  stats: SentStats;
}
export interface SentLog { scheduled: SentMessage[]; messages: SentMessage[]; hasMore: boolean; canWrite: boolean }

export interface InboxMessage {
  id: string;
  clubId: string;
  clubName: string;
  clubPhotoUrl: string | null;
  title: string | null;
  body: string;
  hasPhoto: boolean;
  action: MessageAction | null;
  direct: boolean;
  deliveredAt: string;
  read: boolean;
}
export interface Inbox { messages: InboxMessage[]; unread: number }
export interface Prefs { clubId: string; clubName: string; promoMuted: boolean }
export interface TapResult { type: 'table' | 'tournament'; ref: string; clubId: string; available: boolean }

export interface ComposeBody {
  title: string | null;
  body: string;
  tz: string;
  audience?: AudienceKey;
  recipientId?: string;
  action?: { type: 'table' | 'tournament'; ref: string };
  sendAt?: string;
  photo?: string;
}
export interface ComposeResult { id: string; scheduled: boolean; sendAt: string | null; recipientCount: number }

export type PosterInput =
  | { kind: 'welcome'; firstLine: string; message: string; extraLine?: string }
  | { kind: 'tournament'; tournamentId?: string | null; name: string; when: string; secondLine?: string };
export interface PosterFile { filename: string; mimeType: string; base64: string }

export const QUERY_KEYS = {
  inbox: ['messages', 'inbox'] as const,
  cards: (clubId: string | null) => ['messages', 'cards', clubId] as const,
  prefs: (clubId: string | null) => ['messages', 'prefs', clubId] as const,
  audiences: (clubId: string | null) => ['messages', 'audiences', clubId] as const,
  targets: (clubId: string | null) => ['messages', 'targets', clubId] as const,
  suggestions: (clubId: string | null) => ['messages', 'suggestions', clubId] as const,
  sent: (clubId: string | null) => ['messages', 'sent', clubId] as const,
};
