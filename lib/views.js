// HTML for sign-in, the desk chooser, admin, and the wrapper around the HQ and desk pages.
const fs = require("fs");
const path = require("path");
const { escapeHtml: esc } = require("./auth");

const PAGES = {};
function pageSource(kind) {
  if (!PAGES[kind] || process.env.NODE_ENV !== "production") {
    let html = fs.readFileSync(path.join(__dirname, "..", "pages", `${kind}.html`), "utf8");
    for (const [a, b] of REPLACE) html = html.split(a).join(b);
    PAGES[kind] = html;
  }
  return PAGES[kind];
}
// Wording that only made sense inside claude.ai
const REPLACE = [
  ["Add it in claude.ai Settings, Connectors.", "Ask Hyperweb to set it up."],
  ["Reconnect ${server} in claude.ai Settings, Connectors.", "Ask Hyperweb to reconnect ${server}."],
  ["Reconnect Crunchbase in claude.ai Settings, Connectors, then", "Ask Hyperweb to reconnect Crunchbase, then"],
  ["Open Signals HQ in claude.ai while signed in.", "Couldn't connect to Signals HQ. Reload the page."],
  ["Open this desk in claude.ai while signed in to see its signals and leads.", "Couldn't connect. Reload the page to see its signals and leads."],
  ["Share the new desk with the customer from its Share menu.", "Give the customer access from Admin."],
];

const LOGO = `<picture><source srcset="https://hyperweb.ca/images/hyperweb-logo-white-text.png" media="(prefers-color-scheme: dark)"><img src="https://hyperweb.ca/images/hyperweb-logo-dark-text.png" alt="Hyperweb" class="shq-logo"></picture>`;
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Public+Sans:wght@400;500;600&display=swap">`;
const BASE_CSS = `
:root{--bg:#f2f4f7;--surface:#fff;--sunk:#e6eaf0;--line:#d3d9e2;--fg:#141b26;--muted:#5a6475;--accent:#1d4ed8;--accent-fg:#fff;--good:#17733a;--good-soft:#d9efe0;--bad:#b0321e;--bad-soft:#f7ddd7;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f141c;--surface:#161d28;--sunk:#1e2735;--line:#2c3746;--fg:#e3e9f2;--muted:#93a0b4;--accent:#7aa2ff;--accent-fg:#0b1220;--good:#6fd08a;--good-soft:#153222;--bad:#f08a78;--bad-soft:#3d1c16;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Public Sans",system-ui,sans-serif}
h1,h2{font-family:"Familjen Grotesk",system-ui,sans-serif;margin:0}
.shq-logo{height:30px;width:auto;display:block}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:6px;padding:9px 14px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
input,select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:9px 10px;width:100%}
label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--muted);font-weight:500}
.muted{color:var(--muted)}.ok{background:var(--good-soft);color:var(--good);padding:10px 12px;border-radius:6px;margin:0}.err{background:var(--bad-soft);color:var(--bad);padding:10px 12px;border-radius:6px;margin:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

function shell(title, body, extraCss = "") {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${BASE_CSS}${extraCss}</style></head><body>${body}</body></html>`;
}

function login({ next, sent, email = "", error = "" }) {
  return shell("Sign in · Signals HQ", `
<main style="min-height:100vh;display:grid;place-items:center;padding:24px 16px">
  <div class="card" style="width:100%;max-width:420px;display:flex;flex-direction:column;gap:18px">
    ${LOGO}
    <div><h1 style="font-size:26px">Signals HQ</h1><p class="muted" style="margin:4px 0 0">Managed lead generation by Hyperweb</p></div>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    ${sent ? `<p class="ok">If ${esc(email)} has access, a sign-in link is on its way. It expires in 20 minutes.</p><a class="btn" href="/login?next=${encodeURIComponent(next)}">Use a different email</a>` : `
    <form method="post" action="/login" style="display:flex;flex-direction:column;gap:14px">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>Work email<input type="email" name="email" required autocomplete="email" autofocus></label>
      <button class="btn primary" type="submit">Email me a sign-in link</button>
    </form>
    <p class="muted" style="margin:0;font-size:13px">No password needed. We email you a one-time link.</p>`}
  </div>
</main>`);
}

function message(title, text) {
  return shell(title, `<main style="min-height:100vh;display:grid;place-items:center;padding:24px 16px"><div class="card" style="max-width:440px;display:flex;flex-direction:column;gap:14px">${LOGO}<h1 style="font-size:22px">${esc(title)}</h1><p class="muted" style="margin:0">${esc(text)}</p><a class="btn" href="/">Back</a></div></main>`);
}

function bar(user, here) {
  const staff = user.role === "staff";
  return `<style>
.shq-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 18px;padding:10px max(16px,env(safe-area-inset-left,0px));border-bottom:1px solid var(--line,#d3d9e2);background:var(--surface,#fff);font:14px/1.4 "Public Sans",system-ui,sans-serif;color:var(--fg,#141b26);margin:-18px calc(-1 * max(16px,env(safe-area-inset-left,0px))) 18px}
.shq-bar .shq-logo{height:26px;width:auto;display:block}.shq-bar nav{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center}
.shq-bar a{color:inherit;text-decoration:none;padding:4px 2px;border-bottom:2px solid transparent}.shq-bar a[aria-current]{border-bottom-color:var(--accent,#1d4ed8);font-weight:600}
.shq-bar form{margin:0}.shq-bar button{font:inherit;background:none;border:1px solid var(--line,#d3d9e2);border-radius:6px;padding:4px 10px;color:inherit;cursor:pointer}
.shq-bar .who{color:var(--muted,#5a6475);font-size:13px}</style>
<header class="shq-bar"><a href="/" aria-label="Signals HQ home">${LOGO}</a><nav>
${staff ? `<a href="/hq" ${here === "hq" ? 'aria-current="page"' : ""}>HQ</a><a href="/admin" ${here === "admin" ? 'aria-current="page"' : ""}>People and access</a>` : ""}
<span class="who">${esc(user.name || user.email)}</span><form method="post" action="/logout"><button type="submit">Sign out</button></form></nav></header>`;
}

function page(kind, space, user, extra = {}) {
  const cfg = { space, user: { id: user.id, name: user.name, email: user.email, team: user.role === "staff", canWrite: user.can_write }, capabilities: ["db", "user", "mcp", "sample"] };
  const inject = `${bar(user, kind)}<script>window.__SHQ=${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script><script src="/claude-shim.js"></script>`;
  let html = pageSource(kind).replace("<body>", "<body>" + inject);
  if (kind === "desk" && extra.deskName) html = html.replace("<title>Hyperweb Signals Desk</title>", `<title>${esc(extra.deskName)}: Signals Desk</title>`);
  html = html.replace("<html>", '<html lang="en-CA">');
  return html;
}

function chooser({ user, desks }) {
  return shell("Your desks · Signals HQ", `<div style="padding:18px 16px 0">${bar(user, "")}</div>
<main style="max-width:720px;margin:0 auto;padding:8px 16px 48px;display:flex;flex-direction:column;gap:14px">
<h1 style="font-size:26px">Your Signals desks</h1>
${desks.length ? desks.map((d) => `<a class="card" style="padding:16px 18px;color:inherit;text-decoration:none;display:block" href="/desk/${encodeURIComponent(d.id)}"><b>${esc(d.name)}</b><br><span class="muted" style="font-size:13px">${esc(d.type || "")}</span></a>`).join("") : `<p class="muted">No desks are set up for your account yet. Ask Hyperweb to add yours.</p>`}
</main>`);
}

function admin(user) {
  return shell("People and access · Signals HQ", `<div style="padding:18px 16px 0">${bar(user, "admin")}</div>
<main style="max-width:1100px;margin:0 auto;padding:8px 16px 48px;display:flex;flex-direction:column;gap:16px">
<div><h1 style="font-size:28px">People and access</h1><p class="muted" style="margin:4px 0 0">Hyperweb team members see HQ and every desk. Partners and clients see only the desks you tick. Sign-in is by emailed link.</p></div>
<section class="card" style="display:flex;flex-direction:column;gap:14px;padding:20px">
  <h2 style="font-size:19px" id="fTitle">Add someone</h2>
  <form id="uForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
    <label>Email<input name="email" type="email" required></label>
    <label>Name<input name="name"></label>
    <label>Role<select name="role"><option value="partner">Agency partner</option><option value="client">Client</option><option value="staff">Hyperweb team</option></select></label>
    <label>Access<select name="canWrite"><option value="1">Can work the desk</option><option value="0">View only</option></select></label>
    <fieldset id="deskBox" style="grid-column:1/-1;border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-wrap:wrap;gap:8px 18px"><legend class="muted" style="font-size:13px;padding:0 4px">Desks</legend></fieldset>
    <div style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
      <button class="btn primary" type="submit">Save</button>
      <label style="flex-direction:row;align-items:center;gap:6px;color:var(--fg)"><input type="checkbox" name="sendLink" checked style="width:auto"> Email them a sign-in link</label>
      <button class="btn" type="button" id="fReset">Clear</button><span id="fMsg" class="muted"></span>
    </div>
  </form>
</section>
<section class="card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:760px" id="uTable"></table></section>
</main>
<style>th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--sunk)}td small{color:var(--muted)}tr.off td{opacity:.55}</style>
<script>
const $=s=>document.querySelector(s), esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ROLE={staff:"Hyperweb team",partner:"Agency partner",client:"Client"};
let D={users:[],desks:[]};
async function api(m,u,b){const r=await fetch(u,{method:m,headers:b?{"content-type":"application/json"}:{},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||"Failed");return j;}
async function load(){D=await api("GET","/api/admin/users");draw();}
function draw(){
  $("#deskBox").innerHTML='<legend class="muted" style="font-size:13px;padding:0 4px">Desks</legend>'+D.desks.map(d=>'<label style="flex-direction:row;align-items:center;gap:6px;color:var(--fg)"><input type="checkbox" name="desk" value="'+esc(d.id)+'" style="width:auto"> '+esc(d.name)+'</label>').join("");
  const dn=id=>(D.desks.find(d=>d.id===id)||{}).name||id;
  const t=v=>v?new Date(v).toLocaleString("en-CA",{timeZone:"America/Toronto",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"Never";
  $("#uTable").innerHTML="<thead><tr><th>Person</th><th>Role</th><th>Desks</th><th>Access</th><th>Last sign-in</th><th></th></tr></thead><tbody>"+D.users.map(u=>'<tr class="'+(u.active?"":"off")+'"><td><b>'+esc(u.name||"–")+'</b><br><small>'+esc(u.email)+'</small></td><td>'+ROLE[u.role]+(u.active?"":" · removed")+'</td><td>'+(u.role==="staff"?"All":u.desks.map(dn).map(esc).join("<br>")||"None")+'</td><td>'+(u.can_write?"Can work":"View only")+'</td><td>'+t(u.last_login)+'</td><td style="white-space:nowrap"><button class="btn" data-edit="'+esc(u.email)+'">Edit</button> <button class="btn" data-link="'+esc(u.email)+'" '+(u.active?"":"disabled")+'>Send link</button> <button class="btn" data-off="'+esc(u.email)+'">'+(u.active?"Remove":"Restore")+'</button></td></tr>').join("")+"</tbody>";
  document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>edit(D.users.find(u=>u.email===b.dataset.edit)));
  document.querySelectorAll("[data-link]").forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api("POST","/api/admin/users/link",{email:b.dataset.link});b.textContent="Sent";}catch(e){b.textContent=e.message;}});
  document.querySelectorAll("[data-off]").forEach(b=>b.onclick=async()=>{const u=D.users.find(x=>x.email===b.dataset.off);try{await api("POST","/api/admin/users",{email:u.email,name:u.name,role:u.role,desks:u.desks,canWrite:u.can_write,active:!u.active});load();}catch(e){$("#fMsg").textContent=e.message;}});
}
function edit(u){const f=$("#uForm");f.email.value=u.email;f.name.value=u.name;f.role.value=u.role;f.canWrite.value=u.can_write?"1":"0";f.sendLink.checked=false;
  f.querySelectorAll("[name=desk]").forEach(c=>c.checked=u.desks.includes(c.value));$("#fTitle").textContent="Edit "+(u.name||u.email);f.scrollIntoView({block:"nearest"});}
$("#fReset").onclick=()=>{$("#uForm").reset();$("#fTitle").textContent="Add someone";$("#fMsg").textContent="";};
$("#uForm").onsubmit=async e=>{e.preventDefault();const f=e.target,m=$("#fMsg");m.textContent="Saving…";
  try{await api("POST","/api/admin/users",{email:f.email.value,name:f.name.value.trim(),role:f.role.value,canWrite:f.canWrite.value==="1",desks:[...f.querySelectorAll("[name=desk]:checked")].map(c=>c.value)});
    if(f.sendLink.checked)await api("POST","/api/admin/users/link",{email:f.email.value});
    m.textContent=f.sendLink.checked?"Saved, sign-in link sent.":"Saved.";f.reset();$("#fTitle").textContent="Add someone";load();}catch(x){m.textContent=x.message;}};
load();
</script>`);
}

module.exports = { login, message, page, chooser, admin };
