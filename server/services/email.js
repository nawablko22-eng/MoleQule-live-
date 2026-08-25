// Outbound email — right now just for password reset links, but any
// future "email a receipt" / "email a certificate" feature would go
// through here too. Generic SMTP (via Nodemailer) rather than one vendor's
// API, so it works with a Gmail app password, Resend's SMTP relay,
// SendGrid, Mailgun, or basically any provider — same isConfigured()
// pattern as everything else external in this app (YouTube, VAPID,
// Razorpay): without it, the feature is disabled with a clear message
// instead of crashing.

const nodemailer = require("nodemailer");

let cachedTransport = null;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport() {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return cachedTransport;
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured()) throw new Error("Email isn't configured — see .env.example (SMTP_HOST/SMTP_USER/SMTP_PASS).");
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transport().sendMail({ from: `MoleQule Live <${from}>`, to, subject, html, text });
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  await sendMail({
    to: toEmail,
    subject: "Reset your MoleQule Live password",
    text: `Reset your password: ${resetUrl}\n\nThis link works for 1 hour. If you didn't ask for this, you can ignore this email.`,
    html: `
      <p>Someone (hopefully you) asked to reset the password on your MoleQule Live account.</p>
      <p><a href="${resetUrl}" style="background:#0E7A5F;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Reset password</a></p>
      <p style="color:#666;font-size:.85em;">This link works for 1 hour. If you didn't ask for this, you can safely ignore this email — your password won't change.</p>
    `,
  });
}

module.exports = { isConfigured, sendMail, sendPasswordResetEmail };
