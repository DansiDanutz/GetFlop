# 02 · Accounts & Authentication

## 1. Account model

| Field | Rules |
|---|---|
| `id` | UUID |
| `username` | Unique (case-insensitive, inferred). 3–20 characters from letters, digits, `.`, `-`, `_`. This is the login name and cannot be changed by the user (an admin can change it) |
| `displayName` | 1–30 characters. Must not contain `< > " ' \` backslash or control characters. It is the name others see, and the user can change it |
| `pinHash` | The PIN is 4–8 digits (server rule). The player UI collects exactly **4** digits for login, registration and reset. The admin UI accepts 4–8 |
| `email`, `emailVerified` | Optional for Google-created accounts, required at PIN registration. Unique across accounts |
| `googleSub`, `googleEmail` | Optional linked Google identity (one per account; one account per Google identity) |
| `role` | `player` or `admin` (platform). Bots are a flagged variant |
| `active` | Deactivated accounts cannot sign in, and their sessions are revoked |
| `marketingEmail` | Consent flag (default off). Transactional mail (codes, PIN recovery, account notices) is always sent |
| `lang` | `en` or `el`. Sent at login and registration. The client also stores the choice locally |
| `termsAcceptedVersion`, `adultDeclaredAt` | Player terms / privacy acceptance and 18+ declaration |
| `createdAt`, `lastSeenAt`, device and PWA info | Used by admin views (device label, "app installed", login counts) |

Name validation (usernames, display names, club and room names): printable only, no angle brackets, quotes, backtick, backslash or control characters (`name.invalid_chars`). A tournament name with a damaged Unicode character is rejected (`trm.name_damaged`).

## 2. Registration (username + PIN + email code)

This is a two-step flow on one form.

1. The user fills in username, display name, PIN (4 digits) and confirmation, email, the 18+ checkbox, the "I accept Terms of Use and Privacy Policy" checkbox, and the optional marketing checkbox.
   - Client checks: username and display name are present; both boxes are ticked (`auth.terms_required`); PIN has 4 digits; PIN equals the confirmation; email is present (`auth.email_required`).
2. `POST /auth/register/code` with `{username, displayName, pin, adult, acceptTerms, email, marketingEmail, lang}`.
   - The server validates everything: username format and uniqueness (`auth.username_taken`), email format (`auth.email_invalid`) and uniqueness (`auth.email_taken`), and PIN format.
   - It emails a **6-digit code** and returns `{registrationId}`. If sending fails: `auth.email_send_failed`.
3. The user types the code. `POST /auth/register` with the same fields plus `{registrationId, code}` creates the account (email already verified) and returns `{token, user}`. Code errors:
   - `auth.code_missing` (no pending code)
   - `auth.code_expired`
   - `auth.code_attempts` (too many wrong attempts, so a new code is needed)
   - `auth.code_invalid`
4. "Send a new code" discards the pending registration and repeats step 2.
5. On success: "Welcome, <name>!" and navigation to `#/clubs`.

Rate limiting on every auth endpoint: `auth.too_many` ("try again in a few minutes").

## 3. Login

- `POST /auth/login {username, pin, pwa, lang}`. `pwa` means the app is running installed (standalone display mode) and is used for device statistics.
- Success: `{token, user}`. The token is a bearer token that the client decodes for `userId, username, displayName, role` (inferred JWT).
- Failure: generic wrong credentials (`auth.pin_wrong`), `auth.account_inactive`, `auth.too_many`.
- After login:
  - A platform admin goes to `#/admin`.
  - Everyone else goes to `#/clubs`.
  - If a pending table join exists, they go straight to `#/player` and that table.
  - If a pending club invite exists, the invite banner is shown on `#/clubs`.

### 3.1 One device at a time

- Each successful login creates a new session and **revokes all others** for that user.
- Revoked sessions:
  - get a socket event `session:ended {reason, deviceLabel}`, and
  - get HTTP 401 with code `auth.session_ended` and `params.reason`.
- Client screen: "You signed in on another device" (naming the device when known: an Android phone, an iPhone, an iPad, a Windows computer, a Mac, a Linux computer, another device). It reassures the user that Points and running coupons are unaffected.
- Reason `pin_change` / `pin_reset`: the screen "Your PIN was changed — signed out on every device".
- Expired token: `session.expired` ("log in again").

## 4. Google sign-in

- `GET /auth/google/config` returns `{enabled, clientId}` (inferred). The button is hidden when disabled.
- Inside in-app browsers (Instagram, Facebook, Viber and similar), Google is unavailable. The client shows how to open the page in the default browser. PIN login still works.
- `POST /auth/google {credential, pwa, lang}` (Google ID token):
  - A linked account signs in and returns `{token, user}`.
  - An unknown Google identity returns `{needsRegistration: true, registrationToken, email}`.
- **Finish account**: `POST /auth/google/register {registrationToken, username, displayName, pin, adult, acceptTerms, lang}`.
  - The email comes from Google and counts as verified.
  - If that email already belongs to another account, the user is told to sign in with their PIN and link Google from their account (`auth.email_taken`).
  - Registration token too old: `auth.google_expired`.
- Errors: `auth.google_invalid`, `auth.google_disabled`.
- **Link from account**: `POST /auth/google/link {credential, pin}`.
  - Requires the PIN first.
  - Errors: `auth.google_linked_elsewhere`, `auth.google_already_linked` (unlink the current one first).
- **Unlink**: `DELETE /auth/google/link`.

## 5. Email (add, change, verify)

- `GET /auth/identity` returns `{email, emailVerified, google:{linked, email}, googleEnabled, marketingEmail}` (inferred shape).
- `POST /auth/email {email, pin, lang}` sets or changes the email (the PIN confirms it) and sends a 6-digit code.
- `POST /auth/email/verify {code}` confirms it. It uses the same code errors as registration.
- Email nudge: users without an email see "Add your email — it's how you get back in if you forget your PIN", with "Add email" and "Not now" (inferred: dismissal stored per device).

## 6. PIN reset (forgot PIN)

1. `POST /auth/pin-reset/request {username, lang}`. The response is always neutral ("if the account has a confirmed email, a code is on its way"). The code is 6 digits and expires in **15 minutes**. It only works with a **verified** email.
2. `POST /auth/pin-reset/confirm {username, code, newPin}`. The client checks 4 digits and matching confirmation.
3. On success every session of the user is revoked, and the user signs in again with the new PIN.

## 7. PIN change

`POST /auth/pin/change {pin, newPin}`. A wrong current PIN returns `auth.pin_wrong`. On success, other sessions are signed out with reason `pin_change` (inferred: including other devices).

## 8. Display name

`PUT /auth/display-name {displayName}`. The field autosaves ("Saving…" / "Saved ✓"). Errors: `auth.display_name_required`, `auth.display_name_too_long` (30).

## 9. Terms and consent

- `GET /auth/terms` returns `{required: bool, …}`. When required (new terms version, or never accepted), a blocking sheet asks for the 18+ checkbox and acceptance of the Terms of Use and Privacy Policy. Then `POST /auth/accept-terms {adult, acceptTerms}`.
- **Club terms**: the owner must accept club terms when creating a club (`acceptClubTerms` in create), and again when they change: `POST /clubs/:id/accept-terms {acceptClubTerms:true}`.
  - Only an owner can accept them (`club.terms_owner_only`).
  - Blocking until accepted (`club.terms_required`).
- Marketing consent: `POST /auth/consent {marketingEmail: bool}` (invalid value returns `auth.consent_invalid`).
- Legal texts are static HTML fragments per language: `player-terms`, `privacy-policy`, `club-terms`. The client requires the fragment to start with `<article class="legal"`, otherwise it shows "text could not be loaded".

## 10. Delete account

`POST /auth/delete-account {pin}`. Effects:

- The user leaves every club. Their Points in each club **return to that club's pool** (ledger `membership_ended`).
- Personal identifiers are removed. Club records stay, anonymized.
- If the user owns a club that has **other members**: blocked (`account.last_owner`, naming the club). They must transfer ownership or delete the club first.
- If the user owns a club with no other members, that club closes too.
- Platform admin accounts cannot be deleted from the app (`account.platform_admin`).
- Wrong PIN: `account.pin_wrong`, and nothing is deleted.
- Irreversible.
- Leaving blockers from 03 also apply per club (live coupons, tournament entry, dealing) (inferred).

## 11. Languages

- `en` and `el`. A language switch sits on the login screen and in the account menu. The choice is stored locally (`flopme_lang`) and sent to the server with auth calls (email language).
- Market names are translated client-side by slug. Server-sent notices carry codes plus params, and localized params use `<name>El` variants for Greek.
- Dates and numbers: `en-GB` / `en-US` and `el-GR` locale formatting. The decimal separator in amount inputs follows the language (`.` for en, `,` for el).

## 12. Session plumbing (non-functional but required)

- Bearer token on REST. A socket.io handshake with `auth: {token}` (TV uses `auth: {displayToken}`).
- The client reconnects up to 20 times with 1–5 s backoff. On reconnect it re-joins table rooms and refreshes. The UI shows "Reconnecting…" / "Reconnected".
- The server records device info per login for admin "Devices & app installs": device family, PWA installed, login counts per day.
