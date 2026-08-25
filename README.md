# MoleQule Live Platform

A working prototype for exactly the workflow you described:

1. Teacher creates a course.
2. Teacher schedules a **live class** for that course, choosing who can join —
   **registered students only**, or **everyone (registered + non-registered)**.
3. The moment the teacher actually goes live (starts streaming), every
   allowed student gets a **push notification** with a "Join Live" button.
4. When the class ends, the recording is **automatically pulled from YouTube
   and added to that course's video library** — with YouTube's thumbnail and
   the next sequential video number.
5. The teacher can then open that video entry and **attach a PDF** (notes),
   replace the thumbnail, or reorder it — all from the same screen.
6. When creating a live class, the teacher also picks YouTube's own
   **Private / Unlisted / Public** visibility for that broadcast — separate
   from step 2's app-level access rule (see "Two different privacy
   controls" below) — and gets a **one-click "Open YouTube Studio" button**
   that drops straight into YouTube's live control room for that exact
   broadcast (go live from a webcam right there — no OBS required, though
   OBS details are still available if preferred).
7. An **Admin · Analytics** page (linked from the teacher dashboard) shows
   website visitors, students enrolled, and revenue — overall and broken
   down per course, plus a 7-day trend chart.
8. The home page shows courses as a **product grid, Blinkit-style** — Add
   a paid course to the **Cart**, then **Pay** (Razorpay, with a working
   free demo mode if you haven't connected Razorpay yet). Free courses
   skip the cart and register in one click. See "Selling courses" below.
9. Students/teachers can also **sign up or log in with Google**, not just
   phone + password. Whatever's still missing (a phone number for a
   Google account, an email for an older phone account) is only ever
   asked for once, right at checkout. See "Continue with Google" below.

### Two different privacy controls (don't mix these up)

- **Who this app lets in** (`access_type`, chosen in step 2): the real
  gate. Only students this app decides are allowed ever receive the watch
  link or the notification — enforced by our own code, not YouTube.
- **YouTube's own visibility** (`privacy_status`, chosen in step 6): purely
  about whether the broadcast is discoverable *on YouTube itself*.
  - `unlisted` (recommended default) — not searchable, reachable only via
    the link this app hands out. This is what makes "registered students
    only" actually work at class size.
  - `public` — also listed/searchable on YouTube. Fine for an
    "everyone" open/demo class you want extra reach for.
  - `private` — YouTube blocks anyone whose Google account you haven't
    individually invited, even with the link. Only realistic if you're
    willing to add every student's Google account by hand — not
    recommended for a real class roster, which is why the app defaults
    away from it, but it's there if you want it for a small group.

### Admin · Analytics

Open **Admin · Analytics** from the teacher dashboard to see:
- **Website visitors** — every page load across the student-facing pages
  (login, course pages, the "join live" link from a notification) is logged
  anonymously to `analytics_events`; no cookie/user needed, so it counts
  non-registered visitors too.
- **Students enrolled** — total and per-course, straight from `enrollments`.
- **Revenue** — each course's listed price × how many students registered.
  Once Razorpay is connected (see "Selling courses" below), purchases made
  through the cart really did collect that money — but free-course
  registrations and any enrollment added without Razorpay configured
  (demo-mode checkout, or a teacher adding a student by hand) still count
  toward this number at the course's listed price without real money
  behind them, so treat it as "revenue if every enrolled student paid
  list price," not a reconciled ledger.
- A **7-day trend** (visitors vs. new enrollments) and a **per-course
  table** (page views, students, price, revenue).

It is a real, runnable Node.js app — not a mockup. What it can't do without
you setting up two free-tier accounts first is explained below.

## Why it needs two external accounts

Three things you asked for are **not something any app can do purely with
its own code** — they depend on infrastructure someone already operates:

| Feature you asked for              | Who actually provides it                          |
|-------------------------------------|-----------------------------------------------------|
| Live video streaming                | YouTube (via the YouTube Live Streaming API)        |
| "Video auto-stored on YouTube"      | YouTube (this is literally the same integration)    |
| Push notification to a phone/browser| The browser's push service (Chrome/Firefox/etc.), authenticated with your own VAPID keypair |

The good news: both are free, and both are a one-time setup (see below).
Once set up, everything after that — access control, the content library,
video numbering, PDFs, notifications — runs from this app's own code and
database, with no ongoing third-party cost.

## Project layout

```
server/
  index.js            entry point
  db.js               SQLite schema (courses, enrollments, live_classes, videos, ...)
  middleware/auth.js   JWT cookie auth
  services/
    youtube.js         creates/reads YouTube broadcasts
    youtubeSync.js      background poller: scheduled->live->archived video
    access.js           the enrolled_only / open_to_all access-control rule
    push.js              web-push sending
  routes/               all /api/* endpoints
public/
  index.html            login / register
  teacher.html           dashboard: create course, go live, manage content
  student.html            browse/register for courses, watch, download notes
  watch.html               where a notification's "Join Live" link lands
  sw.js                     service worker (receives push notifications)
uploads/
  pdfs/, thumbnails/       teacher-uploaded files
```

## 1. Run it locally

```bash
npm install
cp .env.example .env
npm run generate-vapid       # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — paste into .env
npm start                    # http://localhost:4000
```

Without the YouTube setup below, everything works **except** creating a
live class (course creation, student registration, manual video+PDF
upload, access control, and notifications-once-live-detected are all
already live). This lets you try the whole student/teacher flow today.

## 2. Connect your YouTube channel (one-time, ~5 minutes)

This whole step now happens **from the app itself** — the teacher
dashboard's **Settings** page (`/settings.html`) — no `.env` editing or
server restarts anywhere in it. Whatever you enter there connects
immediately, the moment you save/submit it.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   a project (or reuse one), and enable **YouTube Data API v3** and
   **YouTube Live Streaming API** under "APIs & Services".
2. Under "APIs & Services" → "Credentials", create an **OAuth client ID**
   (type: Web application). Open **Settings** in the teacher dashboard — it
   shows you the exact **Authorized redirect URI** to paste into that
   client (based on your `BASE_URL`).
3. Back in Settings, paste in the **Client ID** and **Client Secret** and
   hit Save — this takes effect immediately, no restart.
4. Your YouTube channel needs live streaming **enabled** (youtube.com/features
   — this can take up to 24h to activate the first time, so do this step early).
5. Settings now shows a **Connect your YouTube channel** button — click it,
   sign in with the Google account that owns your channel, and grant
   access. You land back on Settings showing **Connected** — done, nothing
   else to copy or restart.

From then on, "Create live class" in the teacher dashboard actually creates
a YouTube broadcast and hands you a stream key. (Under the hood: Client
ID/Secret and the refresh token this earns are stored in the database via
`services/settings.js`, not `.env` — see that file's comment for why, and
for the fallback that keeps an existing `.env`-only deployment working
unchanged if you'd rather set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
there instead.)

## 3. Going live

The teacher dashboard's "Create live class" button gives you an **Ingestion
URL** and **Stream key**. Paste those into any RTMP encoder — most simply,
free software called [OBS Studio](https://obsproject.com) (Settings → Stream
→ Service: Custom). Click "Start Streaming" in OBS.

Within ~15 seconds, this app's background sync notices YouTube's broadcast
flipped to "live" and:
- marks the class live in the database,
- sends the push notification to the right audience (registered-only, or
  everyone, per what the teacher picked when scheduling).

When you stop streaming in OBS, YouTube auto-completes and archives the
recording; once YouTube finishes processing it (usually under a minute for
a short clip, longer for a multi-hour class), this app auto-creates the
video-library entry with YouTube's thumbnail and the next video number.

### Three notifications, not one

Students can get notified up to three separate times per class, each
triggered differently:

1. **"🗓️ New class scheduled"** — fires immediately, the moment the
   teacher clicks *Create live class*. Always sent, whether or not a start
   time was set.
2. **"⏰ Starting in 5 minutes"** — fires automatically, on its own, once
   the class's scheduled time is 5 minutes away. This only happens if the
   teacher actually filled in the optional **"When is this class?"** field
   on the schedule form — no start time means no reminder, since there's
   nothing to count down to. It's driven entirely by the clock (checked
   every ~15s by the same background sync that watches YouTube), so it
   fires even before the teacher opens OBS or YouTube Studio.
3. **"🔴 Live now"** — fires when YouTube's broadcast actually flips to
   live, same as before. This is the one tied to the real stream starting,
   not the scheduled time — if the teacher starts early, late, or the
   scheduled time slips, this still only fires on the real thing.

All three respect the same registered-only vs. everyone audience choice
made when the class was created, and each is logged in `notification_log`
(with a `kind` column: `scheduled` / `reminder` / `live`) so you can see
what actually went out.

The reminder time is written into the push text as IST (`Asia/Kolkata`),
since a push notification is static text with no per-device timezone
formatting — change `formatIST()` in `server/services/push.js` if you ever
deploy for a non-India audience.

## 4. Notifications need HTTPS in production

Web Push works over `http://localhost` for testing, but browsers require
**HTTPS** for it in production. Deploy behind any host that gives you TLS
(Render, Railway, Fly.io, a VPS + Caddy/nginx, etc.) — no code changes
needed, just update `BASE_URL` and `GOOGLE_REDIRECT_URI` in `.env` to your
real domain, and add that domain's callback URL in the Google Cloud OAuth
client too.

## 5. Home page: Shorts folder + Instagram/Facebook buttons

`public/home.html` is the public landing page (no login needed) — it's what
`/` and the brand logo now point to. It has a **Shorts folder**: click it
and it expands into a grid of your channel's YouTube Shorts, same
thumbnails as YouTube, linking straight to `youtube.com/shorts/...`. Upload
a new Short on YouTube and it shows up here on its own — no re-upload, no
manual sync.

This is much simpler to set up than live streaming — it's read-only, public
data, so it just needs an API key (no OAuth consent screen, no refresh
token):

1. In [Google Cloud Console](https://console.cloud.google.com), open the
   same project you used for step 2 (or a new one), enable **YouTube Data
   API v3**, then go to *Credentials → Create Credentials → API key*.
2. Add to `.env`:
   ```
   YOUTUBE_API_KEY=your-api-key
   YOUTUBE_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx
   ```
   Don't know your channel ID? You can use your `@handle` instead —
   set `YOUTUBE_CHANNEL_ID=@YourHandle` and the app will resolve it for you.
3. Restart the server. The Shorts folder goes from "Not connected yet" to
   showing your real videos (results are cached 10 minutes, so a fresh
   upload can take up to that long to appear).

Only videos 3 minutes or under are treated as Shorts (YouTube's own
definition); regular long-form uploads are filtered out automatically.

The footer's **Instagram** / **Facebook** buttons work the same way — just
set the URLs and restart:
```
INSTAGRAM_URL=https://instagram.com/yourhandle
FACEBOOK_URL=https://facebook.com/yourpage
```
Leave either blank and that button simply doesn't render.

## 6. Selling courses: Cart + Checkout (Blinkit-style)

The home page's course grid is a real product grid now, not just a list:
**ADD** a paid course to your cart, open the cart (🛒, top right — badge
shows how many), and **Proceed to Pay**. A free course (price = ₹0) skips
the cart entirely — its button just says **Register free** and enrolls
you on the spot, same as before.

This only applies to paid courses. Set a course's price when creating it
on the teacher dashboard; ₹0 keeps it free.

### Demo mode (works right now, no setup)

Without any Razorpay keys in `.env`, clicking **Proceed to Pay** completes
the order instantly for free and enrolls the student in everything that
was in the cart — so you can see and test the whole Add to Cart → Cart →
Pay flow immediately, exactly like every other feature in this app that
needs an external account.

### Going live with real payments (Razorpay)

1. Create a [Razorpay](https://razorpay.com) account (India-focused,
   UPI/cards/netbanking/wallets all supported) and complete their KYC —
   this step is on Razorpay's side, not this app's.
2. From the Razorpay dashboard, grab your **Key ID** and **Key Secret**
   (Settings → API Keys — use the Test keys first to try it safely).
3. Add to `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
   ```
4. Restart the server. Checkout now opens Razorpay's own payment widget
   instead of completing for free, and a purchase only counts once the
   payment is verified (the widget's response is checked against your Key
   Secret before anyone gets enrolled — see `server/services/payments.js`).

### One more step worth doing: the webhook

There's a real edge case with any browser-driven checkout: if a student's
connection drops or they close the tab right after paying but before this
app's server hears back about it, Razorpay still has their money but this
app never learns the payment succeeded — the order is stuck "pending" and
nobody's enrolled.

The fix is a webhook — Razorpay calls your server directly the moment a
payment succeeds, independent of what the student's browser does:

1. Razorpay dashboard → Webhooks → Add New Webhook, URL:
   `<your BASE_URL>/api/webhooks/razorpay`, events: `payment.captured` and
   `order.paid`.
2. Razorpay gives you a webhook secret (different from your Key Secret) —
   add it as `RAZORPAY_WEBHOOK_SECRET` in `.env` and restart.

Without this, checkout still works correctly for the overwhelming
majority of real purchases — it's just extra insurance for the rare
dropped-connection case, so it's optional, not required to go live.

## 7. "Continue with Google" sign-in

The login/register page has a **Continue with Google** button alongside
the usual phone + password form — either works, and either one is
enough to fully use the app; nobody has to do both.

**It reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`** from step 2
above. If you've already connected YouTube for live streaming, this only
needs one more thing:

1. Google Cloud Console → your OAuth client → **Authorized redirect
   URIs** → add a second one: `<your BASE_URL>/api/auth/google/callback`
   (keep the existing YouTube one too — both are needed, for two
   different things).
2. Set `GOOGLE_LOGIN_REDIRECT_URI` in `.env` to that same URL (already
   defaulted to the localhost version in `.env.example`).
3. Restart the server.

Setting it up from scratch (no YouTube live streaming yet) is the same
Google Cloud OAuth client steps as in section 2, just for this redirect
URI instead.

A student or teacher signing in with Google for the first time gets an
account automatically (matched to their existing account by email if
they'd already signed up with phone + password — no duplicate accounts).
**A Google account has no phone number on file yet** — that's what the
next section is about.

### Filling in what's missing, right when it matters

Rather than a long signup form nobody fills in properly, this app only
asks for `name` / `email` / `phone` when something is actually about to
need it — right now, that's checkout: **`public/cart.html`** checks the
logged-in student's profile before showing the cart, and if anything's
missing (a Google account's phone number, or an older phone-only
account's email) it shows a one-screen "Just need a couple of details"
form first, saves it (`PATCH /api/auth/me`), then continues straight into
the cart. Fields that are already filled in are pre-filled and skipped.

## 8. "Forgot password?" — real email reset

The login page has a **Forgot password?** link. Without any SMTP settings
in `.env`, using it shows a clear "email isn't set up yet" message instead
of crashing — same `isConfigured()` pattern as YouTube/Razorpay/Google.

To make it actually send emails:

1. Get SMTP credentials from any provider — a Gmail account with an [App
   Password](https://myaccount.google.com/apppasswords), Resend's SMTP
   relay, SendGrid, Mailgun, or your host's own mailbox all work the same
   way here (this app uses plain SMTP via Nodemailer, not a vendor API).
2. Add to `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=you@gmail.com
   SMTP_PASS=your-app-password
   SMTP_FROM=you@gmail.com
   ```
3. Restart the server.

A reset link only works for accounts that have an **email** on file — a
phone-only account needs to add one from its account page first. Links
expire after 1 hour and only work once. For privacy, the "forgot password"
response is deliberately the same generic message whether or not that
email is actually registered, so the form can't be used to check who has
an account here.

## 9. Coupons (teacher-managed discount codes)

The teacher dashboard has a **Coupons** link (top bar) → `/coupons.html`:
create a percentage-off code, optionally cap it by number of uses or an
expiry date, and toggle it on/off any time. Students apply a code in their
cart — it's checked twice (once for the live preview, again on the server
right before payment, so nobody can fake a discount from the browser).
When an active coupon exists, its code shows in a banner across the top of
the home page automatically.

## 10. Referral codes (students invite students)

Every student gets a personal referral code and link (shown on their
courses page under **Invite friends, both of you save**, and again as a
banner near the bottom of the home page once logged in). Share the link
(`/index.html?ref=THEIRCODE`) or just the code at signup — when someone
new registers with it, **both accounts** automatically get a one-time 10%
discount coupon (90-day expiry). Referral coupons show up read-only
alongside manual ones on the teacher's Coupons page, but only the student
who earned one can actually use it.

## 11. Account deletion, Privacy Policy, FAQ

Students can permanently delete their own account from their courses page
(**Account → Delete my account**, with a confirmation) — this removes
their cart, registrations, order history, and coupons. It can't be undone,
and it's student-only; a teacher account needs support to close (deleting
a teacher would also affect every student enrolled in their courses).

`/privacy.html` and `/faq.html` are linked from the home page footer — the
privacy page is a plain-language summary (not a substitute for a
lawyer-reviewed policy if you need one for compliance), and the FAQ covers
the most common "how do I…" questions across everything in this app.

## 12. Messages: Telegram + WhatsApp, one inbox

The teacher dashboard has a **Messages** link — one chat inbox for both
Telegram and WhatsApp, so you never have to leave this app to reply to a
student on either one. A **Chat on Telegram** / **Chat on WhatsApp**
button shows up on the student's courses page and in the home page footer
once you've connected a channel.

### Telegram (easy — no approval needed)

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send
   `/newbot`, follow the prompts (pick a name and a username ending in
   `bot`). It gives you a token.
2. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here
   TELEGRAM_BOT_USERNAME=YourBotUsername
   ```
3. Restart the server. It starts polling Telegram immediately — no public
   URL or webhook needed. Message your bot and it shows up in Messages.

A student who opens their **Chat on Telegram** link is automatically
linked to their account (the link carries their student id as a `/start`
parameter) — no extra step for them.

### WhatsApp (needs Meta's approval first)

This one's a real setup, same category as connecting YouTube:

1. Create a [Meta for Developers](https://developers.facebook.com) app,
   add the **WhatsApp** product to it.
2. In WhatsApp → API Setup, you'll get a **temporary access token** and a
   **phone number ID** for a free test number — enough to try this out.
   For production, add a real phone number (needs the usual Meta business
   verification) and generate a **permanent** token (System User, in
   Business Settings) instead of the temporary one.
3. Add to `.env`:
   ```
   WHATSAPP_TOKEN=your-access-token
   WHATSAPP_PHONE_NUMBER_ID=123456789012345
   WHATSAPP_VERIFY_TOKEN=any-string-you-make-up
   WHATSAPP_DISPLAY_NUMBER=919876543210
   ```
4. In the same WhatsApp → Configuration screen, set the **Callback URL**
   to `<your BASE_URL>/api/webhooks/whatsapp` and **Verify token** to
   whatever you put in `WHATSAPP_VERIFY_TOKEN` above, then subscribe to
   the `messages` field. (This step needs `BASE_URL` to be a real public
   HTTPS URL, not localhost — deploy first, or tunnel with something like
   ngrok while testing.)
5. Restart the server.

Replies only work within 24 hours of the student's last message (Meta's
rule for any business — outside that window needs a pre-approved template
message, which this app doesn't set up, since every reply here is always
answering something a student sent first).

## 13. Meta Ads: "Advertise this course"

Every course's teacher dashboard page has an **Advertise** tab. Click
**Advertise this course** and it always does two things immediately, no
setup required:

- Generates a promotional image (a clean templated graphic — course
  title, price, MoleQule Live branding — or, if you've added
  `OPENAI_API_KEY`, a real AI-generated photo instead).
- Writes ad copy for the course.

### Without Meta Ads connected (works today)

You get the image + copy to download and paste into
[Ads Manager](https://adsmanager.facebook.com/) yourself.

### With Meta Ads connected — real one-click publish

1. In [Meta for Developers](https://developers.facebook.com), make sure
   your app has **Marketing API** access, and you have: a **Business
   Manager**, an **Ad Account** with a payment method on it, and a
   **Facebook Page** for MoleQule Live connected to that Business Manager.
2. Generate a token with `ads_management` and `pages_manage_ads`
   permission (Business Settings → System Users → generate token — the
   same token type used for WhatsApp above also works if scoped right).
3. Add to `.env`:
   ```
   META_AD_ACCOUNT_ID=1234567890
   META_ACCESS_TOKEN=your-token
   META_PAGE_ID=your-facebook-page-id
   ```
4. Restart the server.

Now clicking **Advertise this course** creates a real Facebook/Instagram
**Lead Generation** campaign — the ad collects a name/email/phone right
inside Facebook/Instagram without sending anyone to your website — but
**created paused**. You see the exact creative and ad copy first, then hit
**Go live** to actually start spending (default budget is ₹500/day — edit
it in Ads Manager before or after going live).

**Two things worth knowing:**
- Meta reviews every ad before it actually starts showing, even after you
  hit "Go live" here — that review is on Meta's side and isn't
  instant, typically minutes to a day.
- A brand-new ad account usually needs to pass Meta's own business
  verification before `ads_management` access is fully approved — this is
  the same kind of one-time account setup as Razorpay's KYC in section 6,
  not something this app can skip on your behalf.

## 14. Abandoned cart reminders

If a student adds a paid course to their cart and doesn't check out, a
background job (`server/services/cartReminders.js`) checks once an hour
for carts untouched for 24+ hours and sends a "your cart is waiting"
nudge — at most once every 3 days per student, however many stale items
are sitting there.

- **Push notification** — works with zero extra setup, same VAPID keys as
  live-class notifications. This is the reliable channel.
- **WhatsApp** — sent too, if WhatsApp is connected (section 12) and the
  student has a phone number. This is best-effort: Meta only lets a
  business send a free-form message like this outside a 24-hour reply
  window if it uses a pre-approved message **template**, which this app
  doesn't set up. In practice this WhatsApp send will typically fail for
  a student who hasn't messaged your WhatsApp number recently — that's
  expected, logged, and never blocks the push notification.

## 15. Live class attendance tracking

Each live-class row in the teacher dashboard's **Live classes** tab has
an **Attendance** button (once the class isn't just "scheduled" anymore).
It shows who joined and roughly how long they stayed.

This works via a lightweight heartbeat: while a student's `watch.html`
tab is open during a live class, it pings the server every 20 seconds.
The first ping records `joined_at`; every ping after that updates
`last_seen_at`. "Watch time" shown to the teacher is `last_seen_at -
joined_at` — a reasonable estimate of how long they had the class open,
**not** a frame-accurate measurement of whether they were actually
watching (YouTube's own Player API could give that, but needs
significantly more client-side wiring than this heartbeat).

## 16. Test series (MCQ quizzes)

Each course's teacher dashboard has a **Tests** tab: build a multiple-choice
quiz (any number of questions, 4 options each, one marked correct), and
choose whether it's for registered students only or open to everyone —
same access rule used for live classes and videos.

Students see available tests on their course page, take one at
`/test.html`, and get graded **the instant they submit** — grading always
happens server-side against the stored correct answers, the same "never
trust a client-reported score" posture used for coupon/payment amounts
elsewhere in this app. They immediately see which answers were right,
their score, and a leaderboard of the course's other students. Retakes
are allowed; the leaderboard and course listing show each student's best
score.

## 17. Weekly parent progress reports (WhatsApp)

A student can add a parent/guardian's WhatsApp number from their
dashboard (**Parent's weekly progress report** card). Once that's set,
two things become possible:

- **Automatic weekly send** — a background job
  (`server/services/parentReports.js`) checks a few times a day and sends
  each parent a short summary once every 7 days: classes attended and
  tests taken (with average score) in the last week.
- **Manual "Send now"** — on the teacher dashboard's **Students** tab,
  each registered student with a parent number saved gets a **Send parent
  report** button, for sending one on demand (e.g. right before a
  parent call).

**Same WhatsApp caveat as section 14, worth repeating because it applies
here every time, not just occasionally:** this is a business-initiated
message to a number that has (almost always) never messaged your
WhatsApp Business number, so it sits outside Meta's 24-hour free-form
reply window. Without a pre-approved message template, Meta will reject
it. A manual "Send now" shows that rejection to the teacher directly, in
plain language; the automatic weekly job logs it and quietly retries on
its next poll. **To make this actually deliver in production**, apply
for a WhatsApp message template in Meta Business Manager (Business
Settings → WhatsApp Manager → Message Templates) — something like
"Hi, here's {{name}}'s weekly update from MoleQule Live: {{summary}}" —
and once approved, swap `whatsapp.sendMessage`'s plain-text call in
`parentReports.js` for a template send. That template-approval step is
on Meta's side and isn't something this app can do for you (same kind of
one-time account setup as Razorpay's KYC in section 6, or Meta Ads'
business verification in section 13).

## 18. Student reviews on the home page

Any logged-in student can leave a review from their dashboard (**Leave a
review** card): a 1–5 star rating plus a short write-up. It goes live on
the home page's **What students say** section immediately — no approval
needed to publish the first time. A student has exactly one review; if
they submit again, it edits their existing one instead of adding another
(the home page always shows their latest wording, and the average
rating updates too).

**Admin control** lives on the **Admin · Analytics** page's new
**Reviews** table (teacher-only): every review, visible or not, each
with **Hide** (takes it off the home page without deleting it — the
student still sees it as saved on their own dashboard) and **Delete**
(removes it for good). One deliberate rule: editing the text of a review
a teacher has hidden does **not** quietly un-hide it — moderation
decisions stick until a teacher reverses them, so a hidden review can't
be brought back just by the student re-saving it.

## 19. Free courses + access validity (7 days to 24 months) + mandatory live-class time

**Free courses.** On the create-course form there's a **"This is a free
course"** checkbox. Check it and the price field disables itself and
locks to ₹0 — no need to type "0" by hand. A free course skips
cart/checkout entirely: a student clicks **Register (free)** on it and
is enrolled immediately (`POST /api/courses/:id/enroll`), same as
before this feature.

**Access validity.** Every course — free or paid — now requires picking
how long a student's access lasts, from a fixed list: **7 days, 15
days, 1 month, 3 months, 6 months, 12 months, or 24 months.** This is
required at creation time; there's no "forgot to set it" state for new
courses. (Any course that existed before this feature keeps unlimited/
lifetime access automatically — nothing about it silently changed.)

The chosen duration is **frozen the moment a student registers or
buys**, computed forward from right then (`enrolled_at + validity_days`
→ `expires_at`) — this mirrors how this app already freezes a course's
*price* on `order_items` at checkout, so a teacher raising the price
later never retroactively overcharges someone who already paid. The
same idea applies here: if a teacher changes a course's validity later
(see below), it only affects people who register *after* that change —
never anyone already enrolled.

Once `expires_at` passes, access is blocked automatically everywhere
that already checks enrollment — live classes, recorded videos, test
series — via the one shared `services/access.js` helper, so there was
no separate access check to remember to update per feature. The
student's dashboard shows exactly where they stand on every course
card: an upcoming duration ("3 months access") before they register, a
green "Access until 23 Sep 2026" once enrolled, or a red "Access
expired — register again below" once it lapses.

**Renewing after expiry** is just registering/buying again — a free
course re-registers instantly; a paid course goes back through
cart → checkout like any purchase, and completing it extends
`expires_at` forward from that moment rather than erroring or creating
a duplicate enrollment.

**Changing a course's validity later:** on the teacher's course-detail
page, next to the validity label, there's a small **Change** control
(`PATCH /api/courses/:id`) that lets you pick a different duration from
the same 7 options at any time. As above, this is future-only — it
changes what *new* registrations get; it never edits an
`expires_at` that's already been set for a current student.

**Live class time is now mandatory.** The "When is this class?"
date/time field on the schedule-live-class form is required — you can
no longer create a live class with no start time. This was already
useful for the automatic "5 minutes before" reminder (section 3); now
it's guaranteed to always be there.

*A bug this work surfaced and fixed along the way:* the shopping cart's
"you're already registered" check didn't distinguish an active
enrollment from an expired one, so a student whose paid-course access
had lapsed couldn't re-add it to their cart to renew — the app told
them they were "already registered" and blocked the repurchase
entirely. Fixed in `routes/cart.js` to only block re-adding when the
existing enrollment is still active.

## Notes on scope (read this before demoing it to students)

- **PDF/thumbnail storage is local disk** (`uploads/`). Fine for one server;
  move to S3/Cloudinary/GCS if you deploy with multiple server instances or
  want CDN-backed delivery.
- **This is a prototype**, sized to demonstrate the exact workflow you
  described end-to-end and be handed to a developer to harden (rate
  limiting, admin roles, automated tests, etc.) before real students
  depend on it daily.
- **The Meta Ads campaign-creation code (section 13) hasn't been tested
  against a real, approved Ad Account** — I don't have one to test with.
  It's written to match Meta's documented Marketing API flow exactly, but
  the very first real campaign you create is worth double-checking in
  Ads Manager before hitting "Go live". Everything else in this README
  (Telegram, WhatsApp receiving/sending, the templated ad image, coupons,
  referrals, payments, notifications) has been tested end-to-end.
- **WhatsApp's webhook doesn't verify Meta's request signature** — good
  enough for getting started, but before this handles real student
  messages in production, add `X-Hub-Signature-256` verification using
  your app secret (a short addition to `routes/whatsappWebhook.js`).
- **Two features send WhatsApp messages that Meta will often reject
  without a pre-approved template** — abandoned-cart reminders (section
  14) and weekly parent reports (section 17). Both are written
  best-effort on purpose: they try a plain-text send, log/report a clean
  error if Meta rejects it, and never block the rest of the app. See
  section 17 for the actual fix (a Meta-approved message template).
- **Attendance (section 15) is a heartbeat approximation, not
  frame-accurate watch time** — it tells you who opened the class and
  roughly how long the tab stayed open, not whether they were actually
  watching.
- Cart reminders, attendance, test series, and parent reports (sections
  14–17) have all been tested end-to-end — grading, leaderboards, the
  weekly cooldown logic, and every access-control/error path — the same
  way as everything else in this README.
