// Outgoing system email (sign-in links). Uses Resend when RESEND_API_KEY is set,
// otherwise the Gmail API, otherwise writes the message to the log.
// Env: RESEND_API_KEY, MAIL_FROM ("Signals HQ <signals@signals.hyperweb.ca>"), MAIL_REPLY_TO (optional)
const gmail = require("./gmail");

const configured = () => !!process.env.RESEND_API_KEY || gmail.configured();

async function send({ to, subject, text, html }) {
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || "Signals HQ <signals@signals.hyperweb.ca>",
        to: [].concat(to), subject, text, html,
        ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO } : {}),
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`Resend ${r.status}: ${j.message || j.name || "send failed"}`);
    }
    return r.json();
  }
  if (gmail.configured()) return gmail.send({ to, subject, text, html });
  console.log(`[mail] No mail service set up. To: ${to} | ${subject}\n${text}`);
}

module.exports = { configured, send };
