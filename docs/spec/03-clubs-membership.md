# 03 · Clubs & Membership

## 1. Club model

| Field | Rules |
|---|---|
| `id` | UUID |
| `publicId` | **7-digit Club ID**, unique, used for search and the invite URL `/c/<publicId>` |
| `name` | 3–80 characters, safe characters only (`club.name_invalid`, `name.invalid_chars`) |
| `description` | Optional, up to 1,000 characters (`club.description_too_long`) |
| `logo` / photo | JPEG, PNG or WebP, size-capped (`club.logo_invalid`, `club.logo_too_large`). A client-side crop picks the visible band of the club card (drag and pinch/slider zoom) |
| `kind` | `club` (normal) or `arena` (the platform Arena pseudo-club, see 11) |
| `status` | active / deleted (restorable for N days) |
| `level` | Club Level (12-billing-commerce.md). New clubs start on **Starter** (free) |
| `billingEnforced` | Pilot or charged |
| `termsAcceptedVersion` | Club terms acceptance by the owner |
| Settings | `dealerSitApproval` (bool), `liveBigPoints` (threshold), board enabled flag (inferred), rooms |
| Special clubs | "FlopMe Club" (the simulation club, fixed id) is the only place where the Simulation module runs |

### 1.1 Free-club rule

An owner may hold **only one club on the free Starter level**.

- Creating another club while one free club already exists is allowed to set up, but the new club **cannot open tables or accept members** until it moves to a paid Level ("Needs a paid Club Level"). The floor shows this as the top danger row (`levelLocked`). Codes: `club.free_limit`, `club.level_required_billing` / `_staff`.
- Downgrading a club to Starter while the owner already has a free club is blocked (`commerce.level_free_club_held`, `_owner`). A scheduled downgrade that hits this rule at renewal does not take effect, and the owner is notified.

## 2. Create a club

`POST /clubs {name, description, acceptClubTerms}`

- The creator becomes the **owner**. Club terms must be accepted (`club.terms_required`).
- The server creates one default room (inferred) and returns the club.
- If the owner already has a free club, the UI warns that the new one needs a paid Level before it opens tables or accepts members.
- The club is then set as active (`POST /clubs/select {clubId}`).

## 3. Setup checklist ("First steps", the 5-step guide)

`GET /clubs/:id/setup` → `{ complete, total, steps[{key, done, optional}] }`.

| # | Key | Done when | "Go" action |
|---|---|---|---|
| 1 | `photo` | Club has a photo/logo (and name) | Open settings |
| 2 | `table` | At least one table has been opened | Open the first closed table with a dealer, or create a table |
| 3 | `dealer` | Some member holds the Dealer role (or the owner dealt) | "I'll deal myself": grants the owner the dealer role (confirm: "you also become a dealer; one table at a time; cannot play the table you deal") |
| 4 | `players` | At least one member joined, or an invite was shared (inferred) | Open the invite sheet (link / QR) |
| 5 | `points` | Points were sent to a player | Open Members filtered to players |
| – | `level` (optional) | A paid Level chosen | Club account |

UI rules:

- Staff navigation shows a dot on "Club" and a "Setup n/total" badge until all required steps are done.
- The floor shows a **Next step** card ("Next step · n of total", with Skip/Next cycling through undone steps, and "All steps"). Each step ticks itself when done.
- Non-owners see "The owner does this" where a step is owner-only.
- When setup is incomplete and the member has the inspector surface, entering the club opens the staff surface first.

## 4. Finding and joining a club

### 4.1 Ways in

1. **Club ID**: the player types the 7-digit ID (`club.id_invalid` if not 7 digits). `GET /clubs/find/:publicId` returns the public card (name, description, photo, member/table counts, my membership status). Not found: `club.not_found`. Then "Request to join", which sends `POST /clubs/:id/join {source:"club_id"}`.
2. **Invite link / QR**: `https://<app>/c/<publicId>`. The landing page stores a pending invite and routes through login or registration. On `#/clubs` a banner says "You were invited to X — ask to join" and the join request carries `source:"invite"`. States shown:
   - already a member ("tap its card")
   - pending
   - invalid link
3. **Table QR**: `#/join/<joinCode>`. If the user is not a member of the table's club: "Table T belongs to club C — request access". The request carries `source:"qr"`. Once approved, tapping the club goes straight to that table.
4. **Desk scan of player code** (staff-initiated, §6).

### 4.2 Join request rules

- Errors: `club.already_member`, `club.request_pending`, `club.join_failed`.
- Every new member needs approval by an owner, manager or inspector (`club.review_denied` for others).
- Approval respects the Level's **member capacity**:
  - Owner or billing role: `commerce.capacity_members_billing {used, limit, nextLevel, player}`.
  - Other staff: `commerce.capacity_members_staff`.
- A club paused for unpaid renewal cannot approve members (paused codes).
- `GET /clubs/:id/join-requests` lists pending requests. `POST /clubs/:id/join-requests/:membershipId/{approve|reject}` decides one. The requester gets a socket and notice ("approved" / "declined"). `club.request_not_found` if it is already handled.
- Request sources shown to staff: invite link, scanned at the desk, QR, Club ID.
- A member who was previously set to **watch-only** and rejoins comes back watch-only (the staff card says so).
- Membership statuses: `pending` (asked to join), `active` (member), `left`, `removed` (by whom), `rejected` (not accepted).

## 5. Active club context

- `GET /clubs/mine` returns my clubs with `membershipStatus, roles, memberCount, tableCount, liveCoupons, awayWinCents` ("you won +X" since last visit), a news flag, and `activeClubId`.
- `GET /clubs/context` returns the active club `{id, name, publicId, kind, roles[], surfaces[], capabilities[], levelLocked, setup, …}` and `me` (for example `welcomeDue`). It is cached about 15 s on the client.
- `POST /clubs/select {clubId}` sets the active club. If another window of the same user switches club, the socket sends `club:switched` and this window asks the user to pick again.
- Role changes push `club:context-changed` ("your permissions in this club were changed").
- Removal pushes `club:membership-changed {status:"removed", clubId, clubName}` and the user is sent to `#/clubs`.
- Error `club.context_required` when an endpoint needs an active club. `club.access_denied` for non-members. `club.ambiguous` when a platform-level action needs the club named.

## 6. Player code and desk scan

- `GET /clubs/player-code` returns `{code}`, shown as a QR of `https://<app>/#/pc/<code>`.
  - `code = <userId UUID>.<9–11 digit time counter>.<22-char base64url signature>` (HMAC, inferred).
  - It **rotates every 60 s** (the client refetches each minute and holds a screen wake lock). A photo of it is useless.
  - Offline: "the code cannot be shown right now".
- Staff "Scan QR" (Members tab, or identity menu) accepts:
  - player codes
  - table join links
  - club invite links
  - Other codes: "That is not a FlopMe code" / "That code is not used here".
  - Old-style `#/inspector/player/<uuid>` codes: `club.scan_code_old`.
- `POST /clubs/:id/scan {code}` (owner, manager or inspector only; `club.scan_denied`) returns `{state, player{id, displayName, username}, endedAt?}`:
  - `active`: open that member's card.
  - `pending`: "already asked to join, waiting in Requests" (button to Requests).
  - `left` / `removed`: "left on / was removed on <date>". Offer "send a new join request".
  - none: "not a member yet". Offer "send a join request".
- `POST /clubs/:id/scan/request {code, confirmReturn}` creates the join request on the player's behalf (`club.scan_confirm_return` if a former member needs `confirmReturn=true`).
  - It still needs normal approval.
  - The player is notified ("the staff of C sent a request for you to join").
- Code errors: `club.scan_code_expired`, `club.scan_code_invalid`, `club.scan_already_member`, `club.scan_failed`.
- If the staff member belongs to several clubs, "For which club?" is asked first.

## 7. Invite sheet

- Shows the club name, "ID 1234567" (tap to copy), the QR of the invite link, and buttons: send the link (Web Share API with the text "Join <club> on FlopMe"), send the QR as an image, copy the link.
- The link's server page renders Open Graph tags (name, description, photo) so Viber and Messenger previews show them.

## 8. Roles, play mode, removal, leaving, ownership

Role rules are in 00-overview §3.3.

- `POST /clubs/:id/members/:userId/roles/:role` grants and `DELETE …` revokes (`role ∈ manager|inspector|dealer`).
  - Errors: `members.forbidden`, `members.self_change`, `members.rank_too_high`, `members.target_outranks`, `members.role_unknown`, `members.owner_transfer_only`, `members.one_owner`, `members.last_owner`.
  - The confirm text explains each role.
  - Revoking one role keeps the member's other roles and Points.
  - A dealer grant also has a shortcut endpoint `POST /clubs/:id/members/:userId/roles/dealer`.
- `PUT /clubs/:id/members/:userId/play-mode {mode: "play"|"watch"}`. Watch-only members see everything but cannot place coupons or enter tournaments. Invalid mode: `members.play_mode_invalid`.
- **Remove**: `POST /clubs/:id/members/:userId/remove {reason?}`.
  - The member's whole balance returns to the club pool (ledger `membership_ended`).
  - They can ask to join again.
  - Staff sees "<name> was removed. X returned to the club."
  - The removed user is notified.
- **Leave**: `POST /clubs/:id/leave {reason?}`. Balance returns to the pool. Blockers:
  - owner (`club.leave_last_owner`)
  - live coupons in the club (`club.leave_live_coupons {count}`)
  - entered in an upcoming or running tournament (`club.leave_tournament {tournament}`)
  - currently dealing (`club.leave_dealing {table}`)
  - Generic failure: `members.end_failed`.
- **Ended memberships** stay listed under "Left or removed" with the date and actor.
- **Transfer ownership**: `POST /clubs/:id/owner/transfer {userId}` (owner only: `members.owner_only`; `members.owner_self`; `members.owner_state` on a read failure).
  - The new owner gets Diamonds, Level, settings and all roles.
  - The previous owner becomes manager.

## 9. Rooms

- `GET /inspector/rooms`, `POST /clubs/:id/rooms {name}`, `PUT /clubs/:id/rooms/:roomId {name}`, `DELETE /clubs/:id/rooms/:roomId`.
- **One room per club** (`room.one_per_club`, and the Level room capacity `commerce.capacity_rooms_*`). Older clubs with several rooms keep them but cannot add more.
- Name 2–40 characters, unique in the club (`room.name_invalid`, `room.name_taken`).
- A room with tables cannot be deleted (`room.has_tables`). A club keeps at least one room (`room.last`). The reserved "Simulation" room is managed by the platform (`room.reserved`). Missing room: `room.not_found`.
- Reports can break down "By room".

## 10. Club settings & profile

`GET /clubs/:id/settings` and `PUT /clubs/:id/profile {name?, description?, logo?}` (autosave). `club.nothing_to_change` if there is no diff, `club.settings_forbidden`, `club.settings_failed`.

- **Dealers — approval to sit**:
  - `GET/PUT /clubs/:id/dealer-sit-approval {on}`.
  - On: a dealer asks and floor staff approve in Requests. Owners and managers never need approval.
  - Off: a dealer sits at any open table without a dealer immediately.
- **Live — "a big pick"**: `GET/PUT /clubs/:id/live-big {bigPoints}`. Picks and wins ≥ this many Points are flagged in Reports → Live and get their own filter. It must be above 0 with ≤ 2 decimals (`club.live_big_invalid`).
- **Rooms** (§9). **Delete the club** (§12).
- **Club board** visibility toggle (inferred; the board shows "Preview: members do not see this board until you turn it on in the club settings").

## 11. Club home for players (hub, board, medals, notices)

- **Club tiles** ("Everything the club plays"):
  - Ring Games (count, "n live"), tournaments (running / today at time / none yet), Arena (free, outside the club).
  - "What's playing" lines: flop #n, playing now, between hands, no dealer, running, starts at.
- **Club board**: `GET /clubs/:id/board` → `{enabled, preview, period: week|month, metric: net|flops, closesAt, podium, top[{rank, name, value, me}], me{rank,…}, bestMoment{name, payoutOdds, betTypeSlug}}`.
  - Counts only what was played in this club, and only members see it.
  - A member can hide their name: `POST /clubs/:id/board/hidden {hidden}`. Hidden members show as "Member", keeping their place.
  - "Play a flop here to be on the board". A rank-up animation plays after settlement.
- **Place and balance bar** on the table view: `GET /clubs/:id/bar` → my rank on the board, balance, time until the period closes, pending Points request.
- **Club medals** (per club): `GET /clubs/:id/medals`. Medals: First flop here, 10 flops here, 100 flops here, Every table (played on every table), First tournament, Four weeks running. Each shows progress toward the next ("n more flops / tables / weeks").
- **Club notices**: `GET /clubs/notices`, `POST /clubs/notices/:id/read`. Server-generated messages for this user, such as:
  - club deleted: "C was closed by its owner, your Points there have ended"
  - club restored (to the owner)
  - Points pool short (to the owner), stock short
- **Message cards**: club messages with a photo show once as a full card on entering the club (see 08 §6).

## 12. Delete and restore a club

- `GET /clubs/:id/delete-check` → blockers with counts:
  - `openTables`, `tournaments` (upcoming or running), `requests` (Points requests waiting), `returns` (Points returns waiting), `seatedDealers`, `liveCoupons`
  - Plus the consequences: member count, total Points in wallets, Diamond balance.
  - Each blocker has an "Open" shortcut and its own confirm/refund flow.
- `POST /clubs/:id/delete {confirmName, reason}`. Owner only (`club.delete_owner_only`). The name must match exactly (`club.delete_name_mismatch`), a reason is required (`club.delete_reason_required`), and there must be no blockers (`club.delete_blocked`). Effects:
  - All members leave. Wallet Points go back to the club and end with it. Diamonds are lost.
  - Members get the "club deleted" notice.
- **Restore**: platform admin only (`club.restore_admin_only`), within **N days** (`club.restore_expired {days}`; N is a server parameter, open question). The club is restored **empty** with the original owner (`club.restore_no_owner` if the owner is gone). The owner is notified and must re-invite members.

## 13. Help, intro and coach marks (club context)

See 06-player.md §14 for the player-facing tours. Staff screens have a "?" that opens the help topic for the current screen (steps, "good to know", optional video). A help index is at `#/club/help`.
