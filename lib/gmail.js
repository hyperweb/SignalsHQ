// Gmail API sender using an OAuth refresh token for the sending mailbox.
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, MAIL_FROM ("Name <address>").
let cached = { token: null, exp: 0 };

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60e3) return cached.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error_description || "Google token refresh failed"), { code: "unavailable" });
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

const hdr = (s) => (/[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=` : s);

function rfc822({ from, to, cc, bcc, subject, text, html, inReplyTo, references }) {
  const boundary = "b" + Math.random().toString(36).slice(2);
  const head = [
    `From: ${from}`, `To: ${[].concat(to).join(", ")}`,
    cc && `Cc: ${[].concat(cc).join(", ")}`, bcc && `Bcc: ${[].concat(bcc).join(", ")}`,
    `Subject: ${hdr(subject || "")}`, "MIME-Version: 1.0",
    inReplyTo && `In-Reply-To: ${inReplyTo}`, references && `References: ${references}`,
  ].filter(Boolean);
  if (!html) return [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(text || "").toString("base64")].join("\r\n");
  return [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(text || "").toString("base64"),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(html).toString("base64"),
    `--${boundary}--`].join("\r\n");
}

async function gmail(path, opts = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...opts, headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Gmail ${r.status}`), { code: r.status === 429 ? "rate_limited" : "tool_error" });
  return j;
}

async function send(msg) {
  const raw = Buffer.from(rfc822({ from: process.env.MAIL_FROM, ...msg })).toString("base64url");
  return gmail("messages/send", { method: "POST", body: JSON.stringify({ raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) }) });
}

module.exports = { configured, send, gmail };
