require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const { attachUser } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const courseRoutes = require("./routes/courses");
const liveClassRoutes = require("./routes/liveClasses");
const videoRoutes = require("./routes/videos");
const pushRoutes = require("./routes/push");
const youtubeAuthRoutes = require("./routes/youtubeAuth");
const analyticsRoutes = require("./routes/analytics");
const siteRoutes = require("./routes/site");
const cartRoutes = require("./routes/cart");
const { router: couponRoutes } = require("./routes/coupons");
const paymentsWebhookRoutes = require("./routes/paymentsWebhook");
const whatsappWebhookRoutes = require("./routes/whatsappWebhook");
const messageRoutes = require("./routes/messages");
const metaAdsRoutes = require("./routes/metaAds");
const testRoutes = require("./routes/tests");
const parentReportRoutes = require("./routes/parentReports");
const reviewRoutes = require("./routes/reviews");
const youtubeSync = require("./services/youtubeSync");
const telegram = require("./services/telegram");
const cartReminders = require("./services/cartReminders");
const parentReports = require("./services/parentReports");

const app = express();

// Mounted BEFORE express.json(): the Razorpay webhook needs the raw
// request body to verify its signature (see routes/paymentsWebhook.js) —
// once express.json() has parsed a request, those raw bytes are gone.
app.use("/api/webhooks", paymentsWebhookRoutes);

app.use(express.json());
app.use(cookieParser());
app.use(attachUser);

// Public asset uploads (thumbnails + ad creatives only — PDFs are access-checked, see routes/videos.js)
app.use("/uploads/thumbnails", express.static(path.join(__dirname, "..", "uploads", "thumbnails")));
app.use("/uploads/ad-creatives", express.static(path.join(__dirname, "..", "uploads", "ad-creatives")));

app.use("/api/auth", authRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api", liveClassRoutes); // /api/courses/:id/live-classes + /api/live-classes/:id
app.use("/api", videoRoutes); // /api/courses/:id/videos + /api/videos/:id
app.use("/api/push", pushRoutes);
app.use("/api/youtube", youtubeAuthRoutes);
app.use("/api", analyticsRoutes); // /api/analytics/track + /api/admin/overview
app.use("/api", siteRoutes); // /api/shorts + /api/social
app.use("/api", cartRoutes); // /api/cart + /api/checkout(/verify)
app.use("/api", couponRoutes); // /api/coupons(/validate)
app.use("/api/webhooks", whatsappWebhookRoutes); // GET+POST /api/webhooks/whatsapp
app.use("/api", messageRoutes); // /api/conversations(/:id/messages, /:id/reply)
app.use("/api", metaAdsRoutes); // /api/courses/:id/advertise
app.use("/api", testRoutes); // /api/courses/:id/tests, /api/tests/:id(/attempt,/leaderboard,/attempts)
app.use("/api", parentReportRoutes); // /api/students/:id/parent-report/send
app.use("/api", reviewRoutes); // /api/reviews(/me) + /api/admin/reviews(/:id)

app.use(express.static(path.join(__dirname, "..", "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`MoleQule Live Platform running at http://localhost:${PORT}`);
  youtubeSync.start();
  telegram.startPolling();
  cartReminders.start();
  parentReports.start();
});
