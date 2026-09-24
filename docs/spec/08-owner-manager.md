# 08 · Owner & Manager

Owners and managers use the same staff surface as inspectors (07). They also get the Members management features, the Club hub, settings, messages, and (owner only) the Club account and posters.

## 1. The five tabs

| Tab | Route | Content |
|---|---|---|
| **Tables** | `#/inspector` | Floor (Ring Games) and Tournaments (07, 10) |
| **Members** | `#/club/members` | Members & roles, join requests, scan QR, member cards |
| **Requests** | `#/inspector/requests` | New members, Points requests, returns, dealer seat requests |
| **Reports** | `#/inspector/reports` | Live, Hands, Analytics, Report, Club report |
| **Club** | `#/club/hub` | Account, settings, Points, messages, posters, App QR, help, play as player, switch club, language |

- Tapping the active tab again re-selects and refreshes that screen.
- Badges: Requests shows the count waiting. Club shows a dot while setup is incomplete.
- A **Diamond chip** in the header (owner) shows the Diamond balance and opens the Club account.

## 2. Members

- `GET /clubs/:id/members` → `{actor{userId, roles}, members[{userId, username, displayName, roles[], playMode, status, balanceCents?, joinedAt, endedAt?, endedBy?}]}`.
- Header: "Total members: n", "Join requests waiting: n" (opens the requests list), "Scan QR".
- Filters: All, Owner, Manager, Inspector, Dealer, **Players** (members with no staff role). Also a search box by name or username.
- Sort: highest role first, then by name. Rows show avatar initial, name ("you"), @username, role badges or "Player", a "Watch only" badge, and the balance (visible to owner and manager).
- Hint text: "Everyone is a player. Tap a role to give or remove it; set who plays and who only watches."
- "Left or removed" section (ended memberships).
- Deep link `#/club/members?filter=players` (setup "send Points" step).

### 2.1 Member card (`#/club/card/:userId`)

See 04 §8 for the figures. Management actions, each shown only when the rank rules allow it (00 §3.3):

- **Send Out / Claim Back** (04 §4), and **Give / Take stock** for inspectors (04 §5).
- **Roles**: toggle Manager (owner only), Inspector, Dealer. Each change has a confirm explaining the role, and a note if it is disabled ("On your own card you can set only Dealer", "Only the owner changes this member's roles", "Only the owner sets the Manager role").
- **Playing**: Plays / Watch only (confirm texts). Disabled reason: "Only the owner changes this for this member".
- **Remove from club** (optional reason, balance returns to the pool).
- **Transfer ownership** (owner viewing another active member): the confirm explains everything that moves, and that the old owner stays as manager.

## 3. Club hub (`#/club/hub`)

Groups:

- **The club**
  - Diamonds & Club Level (owner): balance, renewal, buy Diamonds.
  - Settings & first steps: photo, name, description, rooms.
  - Points: pool, inspectors' stock, and the check (04 §2).
  - Message players: an announcement to everyone or to one player.
  - Posters (owner): print-ready posters with the club QR.
  - App QR: players scan it to install the app.
- **Floor tools**: Tournaments, Simulation (simulation club only).
- **You**: Play as a player (lobby and tables with your own Points; owner only, because other staff can't play), Switch club (find or create), Language, Help.

## 4. Club settings (`#/club/settings`)

This page shows the first-steps checklist (03 §3), then:

- **Profile**: photo or logo (add, change or remove, with the crop tool), club name, description. Autosave with "Changes save by themselves", "Saving…" and "Saved ✓".
- **Rooms** (03 §9).
- **Dealers**: approval to sit, On / Off (03 §10).
- **Live**: the "big pick" threshold (03 §10).
- **Invite players**: link, QR, Club ID (03 §7).
- **Delete the club** (owner): 03 §12.

Photo processing (client): a square crop chosen by the user (drag, and pinch or slider zoom up to 4×). Then downscale to at most 512 px and encode as JPEG (quality 0.82, falling back to 0.72, shrinking up to 5 times). The target is ≤ 200 KB for the club logo and ≤ 120 KB for message photos. The server re-validates type and size.

## 5. Club account (owner)

See 12-billing-commerce.md for the full rules. The screen (`#/club/account`, `GET /commerce/club/dashboard`) shows:

- A pilot banner ("Free pilot: Level and play charge shown as previews"), or "The free pilot ends on <date> at 12:00 Greek time; from then every Point played is charged <rate> D".
- **Diamonds**:
  - balance, "available after scheduled charges", unpaid charges
  - scheduled in the next 30 days (Level renewal · date)
  - runway ("at the last 7 days' rate, available Diamonds cover about n days", which is about X Points played)
  - the next expiry ("d D expire on date — valid 12 months, oldest spent first")
  - **Buy Diamonds**
- Account state: Healthy / Running low / Critical / Renewal overdue / Diamonds pending / Paused. In the pilot: "Preview only — nothing pauses".
- **Club Level**: current level, renews date for price D (or free), a pending downgrade ("Moves to X at the date renewal" with "Keep the current Level"), **Change Level**.
- **Limits**: Members, Rooms, Ring Games open, Tournaments running, Promotional broadcasts. Each shows used/limit and "over the limit" when over.
- **Play charge this period**, with the rule text. Recent charges (`GET /commerce/club/charges?limit=5`) and "Every play charge" (paginated `limit=50&before=`):
  - hand n · table
  - tournament entry / entry given back · name · player
  - legacy "active player-hand" rows
  - each with "pts played", and "measured, not charged" or "pending"
- **Diamond spend**: last 7 and 30 days, split into Level and Play charge.
- **Account messages** (notifications list, marked read with `POST /commerce/club/notifications/read`).
- **Diamond ledger**, **Card payments** (paid or refunded, Receipt PDF, Credit note PDF).
- **Notifications** preferences (12 §9).
- Promo code entry ("Have a promo code?").

## 6. Club messages (`#/club/messages`)

Sent by owner or manager, with the **club as the sender**. Other staff see a read-only log ("The owner and the manager write the club's messages"). Free and unlimited during the launch period **until 2026-12-01**. After that the Level's monthly promotional-broadcast quota applies (`commerce.capacity_broadcasts_*`).

### 6.1 Composer ("New")

- **To** (audiences; `GET /messages/audiences?tz` returns `{key, count, muted, capped}` for each):

  | Key | Who |
  |---|---|
  | `all` | Everyone in the club |
  | `active_7` | A coupon or a tournament in the last 7 days |
  | `active_30` | A coupon or a tournament in the last 30 days |
  | `inactive_30` | Members for 30+ days with no play since |
  | `new_14` | Joined in the last 14 days |
  | `ring_month` | Played a Ring Game since the 1st of the month |
  | `tourney_month` | Entered a tournament since the 1st of the month |
  | `top_active` | Top 10% of the last 30 days (at least 5 members) |
  | `staff` | Managers, inspectors and dealers |
  | `member` | One member, chosen by searching (`GET /messages/players`) |

  An audience with nobody in it is disabled ("No member is in this group yet").
- **Reach line**: "Will go to n members", "k muted the club", "k already had one today". For a single member: "Will go to <name> only".
- **Title** (optional, ≤ 120 characters). **Message** (required, ≤ 2,000 characters; `messages.too_long {max}`).
- **Photo** (optional, ≤ 120 KB after compression; JPEG/PNG/WebP): "with a photo, members see it as a card when they enter the club, once; without one it goes to their inbox".
- **Button** (optional; `GET /messages/targets` → open `tables[]` and upcoming or running `tournaments[]`):
  - "No button — just the message"
  - "Join <table> — takes them to the table"
  - "Register: <tournament> — opens the tournament"
  - If none is available: "No open table or tournament to point to right now".
- **When**: Send now, or Schedule (date-time; default now + 60 min; must be at least 1 minute ahead and at most **30 days** ahead). A scheduled audience is counted again when it is sent.
- **Preview** ("this is what they will see").
- Confirm:
  - "It goes to n members (<audience>) and cannot be taken back" (plus the button name).
  - Scheduled: "It goes out <when> … you can cancel it until then".
- `POST /messages {title|null, body, tz, audience | recipientId, action?{type:"table"|"tournament", ref}, sendAt?, photo?}` → `{scheduled, sendAt?, recipientCount}`.
- Validation errors:
  - `messages.body_required`, `.too_long`, `.audience_unknown`, `.member_not_found`
  - `.empty_audience {muted, capped}`
  - `.action_unknown`, `.action_unavailable`
  - `.schedule_invalid`, `.schedule_past`, `.schedule_too_far {days}`
  - `.photo_invalid`, `.photo_too_large {maxKb}`

### 6.2 Delivery rules

- **At most one group message per player per 24 hours** (per club, inferred). Players already capped are skipped and counted as "already had one today".
- Players can **mute** a club's announcements (inbox switch). Muted players are skipped.
- **A message to one member always arrives** (it ignores mute and the cap). So do transactional and Points messages.
- A scheduled message whose writer no longer manages the club fails ("its writer no longer manages the club"). Other failure reasons: nobody could receive it, sending interrupted, the member left.

### 6.3 Suggestions ("FlopMe suggests")

`GET /messages/suggestions?tz` → `[{key, kind, audience, params, action?}]`. "Write it" pre-fills the audience, a template title and body, and the button. "Not now" calls `POST /messages/suggestions/:key/dismiss`.

| Kind | Trigger | Audience | Template idea |
|---|---|---|---|
| comeback | n members have not played for 30 days | `inactive_30` | "We miss you at <club>" |
| welcome | n new members in the last 14 days | `new_14` | "Welcome to <club>" |
| tournament | <name> starts <when> | `tourney_month` | invite, with a Register button |
| table | <table> is open with a dealer | `active_7` | "<table> is open now", with a Join button |

The hub shows "n suggestions from FlopMe". Templates must be GetFlop's own wording.

### 6.4 Sent log ("Sent")

- `GET /messages/sent?limit=30&before=<createdAt>` → `{messages[], scheduled[]}`.
- Each entry: audience (or "To <name>", or "All members (before audiences)" for legacy), count, "opened k of n", "tapped n", "joined n", "Written by <name>", status (waiting to go out, goes out <when>, cancelled, "cancelled — was due <when>", "not sent: <reason>"). "Show older".
- Cancel a scheduled one with `POST /messages/:id/cancel` (`messages.not_scheduled` if it is already gone).

### 6.5 Player side

See 06 §10. Tracking: open (read), `POST /messages/:id/tap` (button tapped), joined (a subsequent table join or registration attributed to the message, inferred within a time window).

## 7. Posters (owner)

- Kinds: **Welcome** and **Tournament**. Output is A4 at 300 dpi, as a PDF (for the print shop) and a PNG (for a designer), with the club's permanent QR (invite link).
- Welcome fields: first line, message, extra line (optional, for example "Every Friday from 21:00").
- Tournament fields: pick a tournament or "None — I will type it", tournament name, day and time, second line (optional).
- Live preview. **Download PDF (A4)**, **Image (PNG)**, **Email it to me** (needs an email in My account: `posters.no_email`; send failure: `posters.email_failed`).
- Errors: `posters.owner_only`, `posters.invalid`.
- The rendering location is not visible in the bundle (the client or a server endpoint). Recommended: server-side generation for exact print output (see open questions).

## 8. Play as a player (owner)

The owner can open the player surface in their own club and play with their own Points, except on a table they are dealing.

## 9. Help

- "?" on every staff screen opens that screen's topic: numbered steps, "good to know", an optional video ("coming").
- A help index lists one topic per screen.
- "Show me around again" replays the coach marks.
- The contact block offers Telegram or email.
