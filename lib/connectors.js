// Server-side stand-ins for the claude.ai connectors and Claude calls the pages make.
// Each tool returns the same envelope the pages read: { payload }.
// Tools not wired yet reject with a code the pages already handle, so the feature
// shows as unavailable instead of breaking the page.

class ToolError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

async function jsonFetch(url, opts, label) {
  let r;
  try { r = await fetch(url, opts); } catch (e) { throw new ToolError("unavailable", `${label} could not be reached`, true); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw new ToolError("rate_limited", `${label} is rate limiting requests`, true);
  if (!r.ok) throw new ToolError("tool_error", j.error || j.message || `${label} returned ${r.status}`);
  return j;
}

// ---------- Firecrawl ----------
const fcHeaders = () => {
  if (!process.env.FIRECRAWL_API_KEY) throw new ToolError("server_not_connected", "Firecrawl isn't set up on this server yet");
  return { authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "content-type": "application/json" };
};
const firecrawl = {
  async firecrawl_scrape(a) {
    const body = { url: a.url, formats: a.formats || ["markdown"], onlyMainContent: a.onlyMainContent !== false };
    const j = await jsonFetch("https://api.firecrawl.dev/v1/scrape", { method: "POST", headers: fcHeaders(), body: JSON.stringify(body) }, "Firecrawl");
    return j.data || j;
  },
  async firecrawl_search(a) {
    const body = { query: a.query, limit: Math.min(+a.limit || 5, 20) };
    const j = await jsonFetch("https://api.firecrawl.dev/v1/search", { method: "POST", headers: fcHeaders(), body: JSON.stringify(body) }, "Firecrawl");
    return { web: j.data || [] };
  },
};

// ---------- Crunchbase (REST API v4) ----------
const cbKey = () => {
  if (!process.env.CRUNCHBASE_API_KEY) throw new ToolError("server_not_connected", "Crunchbase isn't set up on this server yet");
  return process.env.CRUNCHBASE_API_KEY;
};
const crunchbase = {
  async cb_expert_resolve_entity(a) {
    const key = cbKey();
    const q = new URLSearchParams({ query: a.name || (a.domains || [])[0] || "", collection_ids: "organizations", limit: "5" });
    const ac = await jsonFetch(`https://api.crunchbase.com/api/v4/autocompletes?${q}`, { headers: { "X-cb-user-key": key } }, "Crunchbase");
    const hit = (ac.entities || [])[0];
    if (!hit) return { found: false, candidates: [] };
    const fields = "short_description,website_url,location_identifiers,num_employees_enum,founded_on,categories,funding_total,last_funding_type,last_funding_at,linkedin";
    const ent = await jsonFetch(`https://api.crunchbase.com/api/v4/entities/organizations/${encodeURIComponent(hit.identifier.permalink)}?field_ids=${fields}`,
      { headers: { "X-cb-user-key": key } }, "Crunchbase");
    return { found: true, name: hit.identifier.value, permalink: hit.identifier.permalink, properties: ent.properties || {}, candidates: (ac.entities || []).map((e) => e.identifier.value) };
  },
};

// ---------- registry ----------
const SERVERS = {
  Firecrawl: { tools: firecrawl, staffOnly: false },
  Crunchbase: { tools: crunchbase, staffOnly: true },
};

async function callTool(server, tool, args, access) {
  const s = SERVERS[server];
  if (!s) throw new ToolError("server_not_connected", `${server} isn't connected to Signals HQ yet`);
  if (s.staffOnly && !access.team) throw new ToolError("not_granted", `${server} is only available to the Hyperweb team`);
  const fn = s.tools[tool];
  if (!fn) throw new ToolError("tool_not_found", `${server} ${tool} isn't available on Signals HQ yet`);
  return { payload: await fn(args || {}) };
}
function listTools() {
  return Object.entries(SERVERS).flatMap(([server, s]) => Object.keys(s.tools).map((name) => ({ server, name })));
}

// ---------- Claude (sample) ----------
const MODELS = {
  quick: process.env.ANTHROPIC_MODEL_QUICK || "claude-haiku-4-5",
  default: process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-5",
  complex: process.env.ANTHROPIC_MODEL_COMPLEX || "claude-opus-4-5",
};
async function sample(input, { modelTier = "default", json = false, maxTokens = 8000 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new ToolError("not_granted", "Claude isn't set up on this server yet");
  const messages = typeof input === "string" ? [{ role: "user", content: input }] : (input || []).map((m) => ({ role: m.role, content: String(m.content) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") throw new ToolError("invalid_argument", "Input must end with a user message");
  const body = {
    model: MODELS[modelTier] || MODELS.default, max_tokens: maxTokens, messages,
    ...(json ? { system: "Reply with valid JSON only. No prose, no code fences." } : {}),
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429 || r.status === 529) throw new ToolError("rate_limited", "Claude is busy", true);
  if (!r.ok) throw new ToolError("unavailable", j.error?.message || `Claude returned ${r.status}`);
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const out = { text, truncated: j.stop_reason === "max_tokens", modelApplied: j.model };
  if (json) out.value = parseJson(text);
  return out;
}
function parseJson(text) {
  const t = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const s = t.search(/[[{]/);
  if (s >= 0) {
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    try { return JSON.parse(t.slice(s, end + 1)); } catch {}
  }
  throw new ToolError("transform_error", "Claude's answer wasn't valid JSON");
}

module.exports = { callTool, listTools, sample, ToolError };
