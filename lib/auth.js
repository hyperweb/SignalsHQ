// Email-link sign-in and cookie sessions. No passwords.
const crypto = require("crypto");
const { pool } = require("./db");
const gmail = require("./gmail");

const COOKIE = "shq_session";
const SESSION_DAYS = 30;
const LINK_MINUTES = 20;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
const newUserId = () => "u_" + crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, 22).padEnd(22, "0");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const safeNext = (p) => (typeof p === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(p) ? p : "/");

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function userByEmail(email) {
  const r = await pool.query("SELECT * FROM users WHERE email=$1", [normEmail(email)]);
  return r.rows[0] || null;
}

async function upsertUser({ email, name = "", role, desks = [], canWrite = true, active = true }) {
  email = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Not a valid email address");
  if (!["staff", "partner", "client"].includes(role)) throw new Error("Role must be staff, partner or client");
  const r = await pool.query(
    `INSERT INTO users (id, email, name, role, desks, can_write, active) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, desks=EXCLUDED.desks, can_write=EXCLUDED.can_write, active=EXCLUDED.active
     RETURNING *`, [newUserId(), email, name, role, desks, canWrite, active]);
  return r.rows[0];
}

async function sendLoginLink(email, next, baseUrl) {
  const user = await userByEmail(email);
  if (!user || !user.active) return; // say nothing either way
  const t = token();
  await pool.query("INSERT INTO login_tokens (token_hash, user_id, next_path, expires_at) VALUES ($1,$2,$3, now() + $4::interval)",
    [sha(t), user.id, safeNext(next), `${LINK_MINUTES} minutes`]);
  const link = `${baseUrl}/auth/verify?t=${t}`;
  const text = `Hi${user.name ? " " + user.name.split(" ")[0] : ""},\n\nHere's your sign-in link for Signals HQ:\n\n${link}\n\nIt works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.\n\nHyperweb Communications`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#141b26;max-width:520px">
    <img src="https://hyperweb.ca/images/hyperweb-logo-dark-text.png" alt="Hyperweb" width="160" style="display:block;margin:0 0 20px">
    <p>Hi${user.name ? " " + escapeHtml(user.name.split(" ")[0]) : ""},</p><p>Here's your sign-in link for Signals HQ.</p>
    <p><a href="${link}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Sign in to Signals HQ</a></p>
    <p style="color:#5a6475;font-size:13px">It works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p></div>`;
  if (gmail.configured()) await gmail.send({ to: user.email, subject: "Your Signals HQ sign-in link", text, html });
  else console.log(`[auth] Gmail not configured. Sign-in link for ${user.email}: ${link}`);
}

async function verifyLoginToken(t) {
  const r = await pool.query(
    `UPDATE login_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, next_path`, [sha(String(t || ""))]);
  if (!r.rowCount) return null;
  const u = await pool.query("SELECT * FROM users WHERE id=$1 AND active", [r.rows[0].user_id]);
  if (!u.rowCount) return null;
  const s = token();
  await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + $3::interval)", [sha(s), u.rows[0].id, `${SESSION_DAYS} days`]);
  await pool.query("UPDATE users SET last_login=now() WHERE id=$1", [u.rows[0].id]);
  return { session: s, next: r.rows[0].next_path };
}

function setSessionCookie(res, s) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${s}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function clearSessionCookie(res) { res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

async function sessionUser(req) {
  const s = cookies(req)[COOKIE];
  if (!s) return null;
  const r = await pool.query(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active", [sha(s)]);
  return r.rows[0] || null;
}
async function logout(req) {
  const s = cookies(req)[COOKIE];
  if (s) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha(s)]);
}

// Which spaces can this user open, and can they write there?
function access(user, space) {
  if (!user) return { read: false, write: false, team: false };
  if (user.role === "staff") return { read: true, write: user.can_write, team: true };
  const m = /^desk:(.+)$/.exec(space || "");
  const ok = !!m && user.desks.includes(m[1]);
  return { read: ok, write: ok && user.can_write, team: false };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

module.exports = { upsertUser, userByEmail, sendLoginLink, verifyLoginToken, setSessionCookie, clearSessionCookie, sessionUser, logout, access, normEmail, safeNext, escapeHtml, sha };
