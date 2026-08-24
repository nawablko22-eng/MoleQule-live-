// SQLite database setup (better-sqlite3: synchronous, zero external server needed).
// Swap this file for a Postgres/MySQL client later without touching the routes much,
// since all access goes through the small helper functions below.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "data", "app.db");
// The data/ folder ships with a .gitkeep so it survives a normal git clone,
// but some deploy paths (a zip re-upload, a host that only materializes
// files it sees referenced, an empty Persistent Disk mount) can still hand
// us a fresh filesystem without it -- better-sqlite3 fails with ENOENT
// opening a file whose parent directory doesn't exist yet, so create it
// defensively before ever opening the database.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
-- phone and password_hash are nullable because a Google sign-in account
-- (see services/googleAuth.js) has neither at first — it's identified by
-- google_id + email instead. SQLite's UNIQUE allows any number of NULLs,
-- so plenty of phone-only accounts and plenty of Google-only accounts can
-- coexist without colliding. The cart/checkout flow asks for whatever's
-- still missing (name/email/phone) the first time it actually matters —
-- see routes/cart.js and the "complete your details" step in cart.html.
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  phone               TEXT UNIQUE,
  email               TEXT UNIQUE,
  google_id           TEXT UNIQUE,
  password_hash       TEXT,
  role                TEXT NOT NULL CHECK (role IN ('teacher','student')),
  -- forgot-password flow (services/email.js) — a random token + expiry,
  -- cleared once used or once a new one is issued.
  reset_token         TEXT,
  reset_token_expires TEXT,
  -- every user gets one of these at signup — share it, and both the
  -- sharer and whoever signs up with it get a discount coupon (see
  -- routes/auth.js register, and the referrals table below).
  referral_code       TEXT UNIQUE,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id   INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT,
  -- listed price in rupees, 0 = free. There's no payment gateway wired
  -- up (see README) so "revenue" in the admin dashboard is price ×
  -- registrations, not a record of real money received.
  price        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "registered" students for a course. A live class or video with
-- access_type = 'enrolled_only' is only visible to rows in this table.
CREATE TABLE IF NOT EXISTS enrollments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id),
  student_id  INTEGER NOT NULL REFERENCES users(id),
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, student_id)
);

-- Blinkit-style "Add to Cart -> Cart -> Pay" flow for paid courses. Free
-- courses (price = 0) skip the cart entirely and enroll directly (see
-- routes/courses.js) — nothing to "buy" there.
CREATE TABLE IF NOT EXISTS cart_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES users(id),
  course_id   INTEGER NOT NULL REFERENCES courses(id),
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, course_id)
);

-- One order per checkout (can cover several courses at once, like a real
-- cart). 'pending' while payment is in flight, 'paid' once confirmed
-- (either by the client-side verify call or the Razorpay webhook —
-- whichever arrives first; both are safe to run twice, see
-- services/orders.js), 'failed' if signature verification failed.
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL REFERENCES users(id),
  total_amount      INTEGER NOT NULL, -- what was actually charged, AFTER any coupon discount
  status            TEXT NOT NULL CHECK (status IN ('pending','paid','failed')) DEFAULT 'pending',
  payment_provider  TEXT, -- 'razorpay' | 'demo' (no gateway configured — see README)
  payment_order_id  TEXT, -- Razorpay's own order id, once created
  payment_ref       TEXT, -- Razorpay's own payment id, once paid
  coupon_code       TEXT, -- the code actually applied, if any (kept even though coupons can change later)
  discount_amount   INTEGER NOT NULL DEFAULT 0, -- rupees knocked off the cart subtotal by that coupon
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at           TEXT
);

-- One row per student, last time they got an "your cart is waiting"
-- nudge (services/cartReminders.js) -- keeps it to at most one every few
-- days per student, however many stale items are sitting in their cart.
CREATE TABLE IF NOT EXISTS cart_reminders (
  student_id  INTEGER PRIMARY KEY REFERENCES users(id),
  sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  course_id   INTEGER NOT NULL REFERENCES courses(id),
  price       INTEGER NOT NULL -- price at time of purchase, in case the course's listed price changes later
);

-- Percentage-off codes. Two flavors, told apart by the source column:
--   'manual'   — a teacher made this from the Coupons tab (routes/coupons.js)
--   'referral' — auto-created by a successful referral (routes/auth.js
--                register), owner_student_id-locked to the one student
--                it's for, max_uses = 1
CREATE TABLE IF NOT EXISTS coupons (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT UNIQUE NOT NULL,
  discount_percent  INTEGER NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  max_uses          INTEGER, -- NULL = unlimited
  used_count        INTEGER NOT NULL DEFAULT 0,
  expires_at        TEXT,    -- NULL = never expires
  active            INTEGER NOT NULL DEFAULT 1,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','referral')),
  created_by        INTEGER REFERENCES users(id),        -- teacher, for a manual coupon
  owner_student_id  INTEGER REFERENCES users(id),         -- set -> only that student can use it (referral coupons)
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per successful "signed up using someone's referral code" —
-- history/audit trail; the actual reward is the pair of coupons created
-- alongside this row (see routes/auth.js register).
CREATE TABLE IF NOT EXISTS referrals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id   INTEGER NOT NULL REFERENCES users(id),
  referred_id   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS live_classes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id           INTEGER NOT NULL REFERENCES courses(id),
  title               TEXT NOT NULL,
  -- who is allowed to join / gets notified:
  --   enrolled_only -> only students in the 'enrollments' table for this course
  --   open_to_all   -> enrolled students AND non-registered/guest visitors
  access_type         TEXT NOT NULL CHECK (access_type IN ('enrolled_only','open_to_all')) DEFAULT 'enrolled_only',
  status              TEXT NOT NULL CHECK (status IN ('scheduled','live','ended')) DEFAULT 'scheduled',
  youtube_broadcast_id TEXT,
  youtube_stream_id   TEXT,
  youtube_stream_key  TEXT,
  youtube_ingestion_url TEXT,
  youtube_studio_url  TEXT,
  -- the broadcast's actual YouTube-side visibility, independent of
  -- access_type above (see server/services/youtube.js for the distinction)
  youtube_privacy_status TEXT CHECK (youtube_privacy_status IN ('private','unlisted','public')),
  youtube_video_id    TEXT,
  -- when the teacher says this class will start (ISO 8601 UTC string set
  -- by the client, optional). Powers two automatic notifications:
  --   1. sent immediately once this row is created ("class scheduled")
  --   2. sent once, 5 minutes before scheduled_at ("starting soon") —
  --      see checkReminders() in services/youtubeSync.js
  -- Neither of these depends on YouTube itself — only on VAPID (push)
  -- being configured. The separate "🔴 live now" notification still only
  -- fires once YouTube's broadcast actually flips to live.
  scheduled_at        TEXT,
  -- set once the 5-minutes-before reminder has actually been sent, so the
  -- background poller never sends it twice
  reminder_sent_at    TEXT,
  started_at          TEXT,
  ended_at            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who actually showed up. One row per (live_class, student), created by
-- the first heartbeat ping from watch.html once the class is live and
-- topped up (last_seen_at) every ~20s the tab stays open -- so
-- last_seen_at - joined_at is a reasonable "how long they watched"
-- estimate without needing YouTube's own Player API.
CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  live_class_id INTEGER NOT NULL REFERENCES live_classes(id),
  student_id    INTEGER NOT NULL REFERENCES users(id),
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(live_class_id, student_id)
);

-- The course's content library. A row here is normally created
-- AUTOMATICALLY once a live_class finishes and YouTube has archived it
-- (see server/services/youtubeSync.js), but a teacher can also add one
-- directly (e.g. an already-edited video) via POST /api/videos.
CREATE TABLE IF NOT EXISTS videos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id      INTEGER NOT NULL REFERENCES courses(id),
  live_class_id  INTEGER REFERENCES live_classes(id),
  title          TEXT NOT NULL,
  video_number   INTEGER NOT NULL,
  youtube_video_id TEXT NOT NULL,
  thumbnail_path TEXT,
  pdf_path       TEXT,
  access_type    TEXT NOT NULL CHECK (access_type IN ('enrolled_only','open_to_all')) DEFAULT 'enrolled_only',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, video_number)
);

-- Test series (MCQ quizzes). Same enrolled_only/open_to_all access rule
-- as live_classes/videos -- see services/access.js.
CREATE TABLE IF NOT EXISTS tests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id    INTEGER NOT NULL REFERENCES courses(id),
  title        TEXT NOT NULL,
  description  TEXT,
  access_type  TEXT NOT NULL CHECK (access_type IN ('enrolled_only','open_to_all')) DEFAULT 'enrolled_only',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id         INTEGER NOT NULL REFERENCES tests(id),
  question_text   TEXT NOT NULL,
  option_a        TEXT NOT NULL,
  option_b        TEXT NOT NULL,
  option_c        TEXT NOT NULL,
  option_d        TEXT NOT NULL,
  correct_option  TEXT NOT NULL CHECK (correct_option IN ('a','b','c','d')),
  order_num       INTEGER NOT NULL DEFAULT 0
);

-- One row per submitted attempt -- a student can retake a test, so this is
-- NOT unique per (test_id, student_id); the leaderboard/teacher view picks
-- whichever aggregate (best/latest) makes sense for that screen.
CREATE TABLE IF NOT EXISTS test_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id         INTEGER NOT NULL REFERENCES tests(id),
  student_id      INTEGER NOT NULL REFERENCES users(id),
  score           INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  completed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id     INTEGER NOT NULL REFERENCES test_attempts(id),
  question_id    INTEGER NOT NULL REFERENCES test_questions(id),
  selected_option TEXT CHECK (selected_option IN ('a','b','c','d')),
  is_correct     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  live_class_id  INTEGER NOT NULL REFERENCES live_classes(id),
  sent_at        TEXT NOT NULL DEFAULT (datetime('now')),
  recipient_count INTEGER NOT NULL DEFAULT 0,
  -- 'scheduled' (class just created), 'reminder' (5 min before start), or
  -- 'live' (broadcast actually went live) — see services/push.js
  kind           TEXT NOT NULL DEFAULT 'live'
);

-- Powers the admin analytics dashboard (server/routes/admin.js):
--   'visit'       -> any page load, site-wide (course_id NULL) or on a
--                    specific course's page (course_id set) — this is the
--                    "website visitors" number.
--   'course_view' -> a student opening a specific course's detail page.
-- Logged anonymously (no user_id) since a visitor may not be logged in.
CREATE TABLE IF NOT EXISTS analytics_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL CHECK (event_type IN ('visit','course_view')),
  course_id   INTEGER REFERENCES courses(id),
  path        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);

-- Credentials entered from an in-app Settings page instead of .env, so
-- connecting something (right now: YouTube) takes effect immediately --
-- no editing .env and restarting the server. See services/settings.js;
-- anything not present here still falls back to the matching .env
-- variable, so an existing env-var-only deployment keeps working as is.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unified admin inbox: one row per external chat (a Telegram chat_id or a
-- WhatsApp phone number), regardless of which channel it's on. student_id
-- is filled in once we can match the sender to an account (Telegram: the
-- student taps a /start deep link from their profile; WhatsApp: matched by
-- phone number automatically) -- until then it's just "WhatsApp +91..." or
-- "Telegram @username" and the teacher can still read/reply to it.
CREATE TABLE IF NOT EXISTS conversations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel           TEXT NOT NULL CHECK (channel IN ('telegram','whatsapp')),
  external_chat_id  TEXT NOT NULL, -- Telegram chat id, or WhatsApp phone number (E.164, no +)
  student_id        INTEGER REFERENCES users(id),
  display_name      TEXT,          -- best name we have: Telegram first/username, or WhatsApp profile name
  last_message_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, external_chat_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  body             TEXT NOT NULL,
  sent_by          INTEGER REFERENCES users(id), -- the teacher/admin who sent an 'out' message; NULL for 'in'
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- One review per student (student_id is UNIQUE -- they edit their
-- existing review rather than piling up new ones). visible defaults to 1
-- so a submitted review shows on the home page right away; a teacher can
-- hide (visible=0) or hard-delete it from the admin Reviews panel (see
-- routes/reviews.js). Editing the TEXT of an already-hidden review does
-- NOT flip it back to visible on its own -- once a teacher has hidden
-- one, it stays hidden until a teacher un-hides it, so moderation can't
-- be silently bypassed by re-submitting.
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL UNIQUE REFERENCES users(id),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text        TEXT NOT NULL,
  visible     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per student, last time their parent got a weekly WhatsApp
-- progress report (services/parentReports.js) -- same shape as
-- cart_reminders, keeps the automatic weekly scheduler from re-sending
-- inside the same week. Only updated on an ACTUALLY successful send, so a
-- send that fails (parent outside WhatsApp's 24h window, no template --
-- see services/parentReports.js) is simply retried on the next poll.
CREATE TABLE IF NOT EXISTS parent_reports (
  student_id  INTEGER PRIMARY KEY REFERENCES users(id),
  sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Lightweight migration for a database file created before a column
// existed — `CREATE TABLE IF NOT EXISTS` above only helps on a brand-new
// database, it does nothing to a table that already exists on disk.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("live_classes", "reminder_sent_at", "TEXT");
ensureColumn("notification_log", "kind", "TEXT NOT NULL DEFAULT 'live'");
// google_id itself is safe to add to an existing database this way. What
// ADD COLUMN can't do is relax phone/password_hash from NOT NULL on a
// database file that already has that constraint baked in — Google
// sign-in still works fine on an old database (it just never touches
// phone/password_hash), this only matters if you want a genuinely
// phone-less account to be possible, which needs a fresh database file.
ensureColumn("users", "google_id", "TEXT");
ensureColumn("users", "reset_token", "TEXT");
ensureColumn("users", "reset_token_expires", "TEXT");
ensureColumn("users", "referral_code", "TEXT");
ensureColumn("orders", "coupon_code", "TEXT");
ensureColumn("orders", "discount_amount", "INTEGER NOT NULL DEFAULT 0");
// A parent/guardian's WhatsApp number, added by the student themselves
// (see PATCH /api/auth/me) so weekly progress reports have somewhere to
// go -- see services/parentReports.js.
ensureColumn("users", "parent_phone", "TEXT");
// How many days a course's access lasts once a student registers for it
// (7/15/30/90/180/365/730 -- see routes/courses.js VALIDITY_OPTIONS).
// NULL means lifetime access -- every course created going forward
// requires picking one of the presets, but this stays NULL (unlimited,
// unchanged behavior) for any course that existed before this feature.
ensureColumn("courses", "validity_days", "INTEGER");
// When THIS registration's access runs out, computed from the course's
// validity_days at the moment of enrolling/purchasing (see routes/courses.js
// POST /:id/enroll and services/orders.js completeOrder) -- frozen at that
// moment like order_items.price is, so a later validity_days change on the
// course never silently shortens or extends an existing student's access.
// NULL means lifetime access, same as above.
ensureColumn("enrollments", "expires_at", "TEXT");

// Backfill a referral code for any account that predates this feature
// (a fresh database never hits this — new rows already get one at
// signup, see routes/auth.js).
function randomReferralCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
const missingReferralCode = db.prepare("SELECT id FROM users WHERE referral_code IS NULL").all();
if (missingReferralCode.length) {
  const setCode = db.prepare("UPDATE users SET referral_code = ? WHERE id = ?");
  for (const { id } of missingReferralCode) {
    let code;
    do { code = randomReferralCode(); } while (db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(code));
    setCode.run(code, id);
  }
}

module.exports = db;
