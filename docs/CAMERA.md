# Table camera: live picture and AI flop reading

Every table is connected to a **host**: a device with a camera, fixed above the table, with the
middle of the felt (where the flop lands) clearly in view. A phone or tablet on a stand, or a small
PC with a webcam, is enough.

## How a hand runs

1. The dealer opens betting in the dealer console. Players bet from the lobby or the table while
   the host streams the table: one picture a second, shown on players' screens, the lobby tiles
   and the TV.
2. Betting closes ("No more bets" or the timer). The host starts reading the flop: every 1.5
   seconds it sends the current picture to the card reader (Claude vision), which names the three
   flop cards and how sure it is.
3. A reading is trusted only when it is **sure** (90% or more), names **three different valid
   cards**, and the **next picture gives the same three cards**. Unclear pictures (dealer's hand in
   the way, a card still moving) are simply read again.
4. What happens next is the table's **camera mode** (Admin → Tables → Camera):
   - **Reads the flop, dealer confirms** (default): the dealer console shows "Camera read Q♥ 4♥ 9♦,
     97% sure". One tap fills in the cards, one more confirms. Every bet settles.
   - **Reads and enters the flop**: the camera enters the flop itself and every bet settles. If the
     table has **dual confirmation** on, the camera counts as the first person and a staff member
     must confirm the same cards; the camera never confirms itself.
   - **Off**: no reading; the dealer enters the flop by hand. The live picture still works.
5. The dealer can always enter the flop by hand, and a supervisor can void a misdeal.

Every reading is stored with its time, cards, confidence and result. The picture behind the reading
that was acted on is kept as evidence and can be opened by a supervisor
(`GET /v1/dealer/rounds/:id/readings`, `GET /v1/dealer/readings/:id/picture`).

## Setting up a table

1. **Server**: set `ANTHROPIC_API_KEY` (in Vercel: Project → Settings → Environment Variables). Without
   it the live picture works but the flop is not read.
2. **Host device**: open `/host.html` (the dealer console has a "Camera host" button), log in with a
   dealer account, pick the table, allow the camera. Keep the page open, the device plugged in and
   the screen on (the page asks the device to stay awake).
3. **Camera position**: straight above the middle of the table, the whole flop area in frame, even
   light, no glare on the cards. Use the Camera menu on the host page to pick the right lens.
4. **Mode**: in Admin → Tables, choose the camera mode. Start with "dealer confirms" and move to
   "reads and enters" once the readings have proved reliable at that table.

## Video

The built-in live picture is one picture a second, sent through GetFlop itself, with nothing else to
run. For smooth, low-delay video (live-casino quality), use a streaming provider (WebRTC or LL-HLS)
and put the player URL in the table's "Video stream URL": players then see that video, and the
host keeps sending pictures for the flop reading.

## Cost and limits

- Each reading is one request to `claude-opus-5-5` with one picture (scaled to 1280 px wide) at low
  effort. Roughly one to two US cents per reading, and usually two to four readings per hand. Check
  current pricing before planning volume.
- Pictures are limited to about 650 KB. The host sends JPEGs of about 100 KB.
- On a policy decline the API re-runs the request on its recommended fallback model; a declined
  reading counts as "not sure" and the next picture is read.
