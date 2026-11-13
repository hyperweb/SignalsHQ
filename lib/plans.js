// Plans, lead balances, top-ups and upgrades.
// Every lead added to or used from a desk is one row in lead_ledger (append-only). The balance is the sum
// of that ledger by bucket, and the same rows are the audit trail of who accepted which lead, and when.
const { pool } = require("./db");
const store = require("./store");

const PLANS = {
  starter: { id: "starter", name: "Starter", leads: 10, price: 950 },
  growth: { id: "growth", name: "Growth", leads: 25, price: 2000 },
  scale: { id: "scale", name: "Scale", leads: 50, price: 3500 },
};
const ORDER = ["starter", "growth", "scale"];
const TOPUP_PRICE = 125;          // per lead, always above every plan's own rate so upgrading is the better deal
const TOPUP_BLOCKS = [5, 10];
const LOW_SHARE = 0.2;            // "running low" banner at 20% of the monthly allowance
const DRAW_ORDER = ["rollover", "plan", "topup"];

const fail = (code, message) => Object.assign(new Error(message), { code });
const money = (n) => Math.round(+n * 100) / 100;

// Dates are plain YYYY-MM-DD in Eastern Time; a cycle runs from cycle_start up to (not including) cycle_end.
function torontoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
function addMonth(ymd) {
  const [y, m, d] = iso(ymd).split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}
const deskOf = (space) => { const m = /^desk:(.+)$/.exec(space || ""); return m ? m[1] : null; };
const ping = (deskId) => store.changes.emit("change", { space: `desk:${deskId}`, coll: "_plan" });

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

async function ledger(c, deskId, e) {
  await c.query(
    `INSERT INTO lead_ledger (desk_id, bucket, kind, qty, signal_id, company, user_id, user_name, note, purchase_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [deskId, e.bucket, e.kind, e.qty, e.signalId || null, e.company || "", e.user?.id || null, e.user?.name || "", e.note || "", e.purchaseId || null]);
}
async function balances(c, deskId) {
  const r = await c.query("SELECT bucket, COALESCE(SUM(qty),0)::int AS n FROM lead_ledger WHERE desk_id=$1 GROUP BY bucket", [deskId]);
  const b = { plan: 0, rollover: 0, topup: 0 };
  for (const row of r.rows) b[row.bucket] = row.n;
  b.total = b.plan + b.rollover + b.topup;
  return b;
}
async function lockPlan(c, deskId) {
  const r = await c.query("SELECT * FROM desk_plans WHERE desk_id=$1 AND active FOR UPDATE", [deskId]);
  return r.rows[0] || null;
}

// Bring a plan up to date: for each cycle that ended, unused plan leads roll over for one more cycle,
// last cycle's rollover expires, any downgrade waiting for renewal applies, and the new allowance is added.
async function renew(c, p) {
  const today = torontoToday();
  let n = 0;
  while (iso(p.cycle_end) <= today && n++ < 36) {
    const b = await balances(c, p.desk_id);
    const label = `${iso(p.cycle_start)} to ${iso(p.cycle_end)}`;
    if (b.rollover > 0) await ledger(c, p.desk_id, { bucket: "rollover", kind: "expiry", qty: -b.rollover, user: { name: "Signals HQ" }, note: "Rolled-over leads expired" });
    if (b.plan > 0) {
      await ledger(c, p.desk_id, { bucket: "plan", kind: "expiry", qty: -b.plan, user: { name: "Signals HQ" }, note: `Unused leads from ${label}` });
      await ledger(c, p.desk_id, { bucket: "rollover", kind: "rollover", qty: b.plan, user: { name: "Signals HQ" }, note: `Rolled over from ${label}, good for one month` });
    } else if (b.plan < 0) {
      await ledger(c, p.desk_id, { bucket: "plan", kind: "adjustment", qty: -b.plan, user: { name: "Signals HQ" }, note: "Reset at renewal" });
    }
    if (p.pending_plan && PLANS[p.pending_plan]) {
      const np = PLANS[p.pending_plan];
      p.plan = np.id; p.monthly_leads = np.leads; p.monthly_price = np.price; p.pending_plan = null;
    }
    p.cycle_start = iso(p.cycle_end); p.cycle_end = addMonth(p.cycle_end);
    await ledger(c, p.desk_id, { bucket: "plan", kind: "allocation", qty: p.monthly_leads, user: { name: "Signals HQ" }, note: `${planName(p)} plan, ${iso(p.cycle_start)} to ${iso(p.cycle_end)}` });
  }
  if (n) {
    await c.query("UPDATE desk_plans SET plan=$2, monthly_leads=$3, monthly_price=$4, pending_plan=$5, cycle_start=$6, cycle_end=$7, updated_at=now() WHERE desk_id=$1",
      [p.desk_id, p.plan, p.monthly_leads, p.monthly_price, p.pending_plan, iso(p.cycle_start), iso(p.cycle_end)]);
  }
  return p;
}
const planName = (p) => (PLANS[p.plan] ? PLANS[p.plan].name : "Custom");

async function shape(c, p) {
  const b = await balances(c, p.desk_id);
  const cyc = await c.query(
    `SELECT
       COALESCE(SUM(-qty) FILTER (WHERE kind='accept' AND created_at >= $2::date),0)::int AS used,
       COUNT(*) FILTER (WHERE kind='topup' AND created_at >= $2::date)::int AS topups,
       COALESCE(SUM(qty) FILTER (WHERE kind='topup' AND created_at >= $2::date),0)::int AS topup_leads,
       COUNT(*) FILTER (WHERE kind='topup' AND created_at >= ($2::date - interval '1 month') AND created_at < $2::date)::int AS topups_last
     FROM lead_ledger WHERE desk_id=$1`, [p.desk_id, iso(p.cycle_start)]);
  const u = cyc.rows[0];
  const i = ORDER.indexOf(p.plan);
  const next = i >= 0 && i < ORDER.length - 1 ? PLANS[ORDER[i + 1]] : null;
  const lower = i > 0 ? ORDER.slice(0, i).map((k) => PLANS[k]) : [];
  const lowAt = Math.max(1, Math.ceil(p.monthly_leads * LOW_SHARE));
  return {
    plan: p.plan, name: planName(p), monthlyLeads: p.monthly_leads, monthlyPrice: money(p.monthly_price),
    cycleStart: iso(p.cycle_start), renews: iso(p.cycle_end), pendingPlan: p.pending_plan || null,
    pendingName: p.pending_plan && PLANS[p.pending_plan] ? PLANS[p.pending_plan].name : null,
    balance: b, left: Math.max(0, b.total), usedThisCycle: u.used, lowAt, low: b.total > 0 && b.total <= lowAt, out: b.total <= 0,
    topupPrice: TOPUP_PRICE, topupBlocks: TOPUP_BLOCKS,
    topupsThisCycle: u.topups, topupLeadsThisCycle: u.topup_leads, topupSpendThisCycle: u.topup_leads * TOPUP_PRICE, toppedUpLastCycle: u.topups_last > 0,
    next: next ? { ...next, upgradeCost: money(next.price - p.monthly_price), extraLeadsNow: next.leads - p.monthly_leads } : null,
    lower,
    billing: { stripe: !!p.stripe_subscription_id, status: p.billing_status },
  };
}

async function status(deskId) {
  return tx(async (c) => {
    const p = await lockPlan(c, deskId);
    if (!p) return null;
    await renew(c, p);
    return shape(c, p);
  });
}

// Uses one lead for an accepted signal. Charges a signal once, however many times it is accepted.
// Desks without a plan (Hyperweb's own and legacy desks) are not metered.
async function accept(deskId, { signalId, company, user }) {
  const r = await tx(async (c) => {
    const p = await lockPlan(c, deskId);
    if (!p) return { metered: false };
    await renew(c, p);
    if (signalId) {
      const seen = await c.query("SELECT 1 FROM lead_ledger WHERE desk_id=$1 AND kind='accept' AND signal_id=$2", [deskId, signalId]);
      if (seen.rowCount) return { metered: true, already: true };
    }
    const b = await balances(c, deskId);
    const bucket = DRAW_ORDER.find((k) => b[k] > 0);
    if (!bucket) throw fail("out_of_leads", `No leads left on the ${planName(p)} plan until ${iso(p.cycle_end)}. Upgrade or top up to accept more.`);
    await ledger(c, deskId, { bucket, kind: "accept", qty: -1, signalId, company, user, note: "Accepted as a lead" });
    return { metered: true };
  });
  if (r.metered && !r.already) ping(deskId);
  return r;
}

// opts.paymentRef: the Stripe session that paid for it (granted once per ref). Without it, Hyperweb invoices later.
async function topup(deskId, block, user, opts = {}) {
  block = +block;
  if (!TOPUP_BLOCKS.includes(block)) throw fail("invalid_argument", `Top-ups come in blocks of ${TOPUP_BLOCKS.join(" or ")}`);
  await tx(async (c) => {
    const p = await lockPlan(c, deskId);
    if (!p) throw fail("invalid_argument", "This desk has no plan yet");
    await renew(c, p);
    const pr = await c.query(
      `INSERT INTO lead_purchases (desk_id, kind, leads, unit_price, amount, from_plan, to_plan, requested_by, requested_by_name, invoice_status, payment_ref)
       VALUES ($1,'topup',$2,$3,$4,$5,$5,$6,$7,$8,$9) ON CONFLICT (payment_ref) DO NOTHING RETURNING id`,
      [deskId, block, TOPUP_PRICE, block * TOPUP_PRICE, p.plan, user.id || null, user.name || user.email || "", opts.paymentRef ? "paid" : "to_invoice", opts.paymentRef || null]);
    if (!pr.rowCount) return; // this payment was already granted
    await ledger(c, deskId, { bucket: "topup", kind: "topup", qty: block, user, note: `Top-up of ${block} leads at $${TOPUP_PRICE} a lead${opts.paymentRef ? ", paid by card" : ""}`, purchaseId: pr.rows[0].id });
  });
  ping(deskId);
  return status(deskId);
}

// Upgrade now: charge the difference in monthly price for this cycle and add the extra leads straight away,
// so the balance becomes the new allowance minus what was already used.
async function upgrade(deskId, to, user, opts = {}) {
  const np = PLANS[to];
  await tx(async (c) => {
    const p = await lockPlan(c, deskId);
    if (!p) throw fail("invalid_argument", "This desk has no plan yet");
    await renew(c, p);
    if (!np || ORDER.indexOf(to) <= ORDER.indexOf(p.plan) || ORDER.indexOf(p.plan) < 0) throw fail("invalid_argument", "Pick a bigger plan than the current one");
    const cost = money(np.price - p.monthly_price), extra = np.leads - p.monthly_leads;
    const pr = await c.query(
      `INSERT INTO lead_purchases (desk_id, kind, leads, amount, from_plan, to_plan, requested_by, requested_by_name, invoice_status, payment_ref)
       VALUES ($1,'upgrade',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (payment_ref) DO NOTHING RETURNING id`,
      [deskId, extra, cost, p.plan, np.id, user.id || null, user.name || user.email || "", opts.paymentRef ? "paid" : "to_invoice", opts.paymentRef || null]);
    if (!pr.rowCount) return;
    await ledger(c, deskId, { bucket: "plan", kind: "upgrade", qty: extra, user, note: `Upgraded ${planName(p)} to ${np.name}`, purchaseId: pr.rows[0].id });
    await c.query("UPDATE desk_plans SET plan=$2, monthly_leads=$3, monthly_price=$4, pending_plan=NULL, updated_at=now(), updated_by=$5 WHERE desk_id=$1",
      [deskId, np.id, np.leads, np.price, user.email || user.id]);
  });
  ping(deskId);
  return status(deskId);
}

// Moving to a smaller plan waits for the next renewal. Pass the current plan (or null) to cancel.
async function scheduleChange(deskId, to, user) {
  await tx(async (c) => {
    const p = await lockPlan(c, deskId);
    if (!p) throw fail("invalid_argument", "This desk has no plan yet");
    const want = to && to !== p.plan ? to : null;
    if (want && (!PLANS[want] || ORDER.indexOf(want) >= ORDER.indexOf(p.plan))) throw fail("invalid_argument", "Only a smaller plan can be scheduled. Upgrades apply right away.");
    await c.query("UPDATE desk_plans SET pending_plan=$2, updated_at=now(), updated_by=$3 WHERE desk_id=$1", [deskId, want, user.email || user.id]);
    await c.query(
      `INSERT INTO lead_purchases (desk_id, kind, amount, from_plan, to_plan, invoice_status, requested_by, requested_by_name)
       VALUES ($1,'change',0,$2,$3,'none',$4,$5)`, [deskId, p.plan, want || p.plan, user.id || null, user.name || user.email || ""]);
  });
  ping(deskId);
  return status(deskId);
}

// ---------- Hyperweb team ----------
// Set or change a desk's plan without charging (new client, custom deal, correction). leads/price only for "custom".
async function setPlan(deskId, { plan, leads, price, start, stripe }, user) {
  if (plan === "none") {
    await pool.query("UPDATE desk_plans SET active=false, billing_status=CASE WHEN stripe_subscription_id IS NULL THEN billing_status ELSE 'canceled' END, updated_at=now(), updated_by=$2 WHERE desk_id=$1", [deskId, user.email || user.name]);
    ping(deskId);
    return null;
  }
  const def = PLANS[plan] || (plan === "custom" ? { id: "custom", leads: Math.round(+leads), price: money(price) } : null);
  if (!def || !(def.leads > 0) || !(def.price >= 0)) throw fail("invalid_argument", "Pick a plan, or a custom plan with leads and a price");
  await tx(async (c) => {
    const cur = (await c.query("SELECT * FROM desk_plans WHERE desk_id=$1 FOR UPDATE", [deskId])).rows[0];
    const linkStripe = async () => { if (stripe) await c.query("UPDATE desk_plans SET stripe_customer_id=$2, stripe_subscription_id=$3, billing_status='ok' WHERE desk_id=$1", [deskId, stripe.customer, stripe.subscription]); };
    if (cur && cur.active) {
      await renew(c, cur);
      const diff = def.leads - cur.monthly_leads;
      await c.query("UPDATE desk_plans SET plan=$2, monthly_leads=$3, monthly_price=$4, pending_plan=NULL, updated_at=now(), updated_by=$5 WHERE desk_id=$1",
        [deskId, def.id, def.leads, def.price, user.email]);
      if (diff) await ledger(c, deskId, { bucket: "plan", kind: "adjustment", qty: diff, user, note: `Plan changed by Hyperweb: ${planName(cur)} to ${PLANS[def.id] ? PLANS[def.id].name : "Custom"}` });
      await linkStripe();
    } else {
      const s = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? start : torontoToday();
      await c.query(
        `INSERT INTO desk_plans (desk_id, plan, monthly_leads, monthly_price, cycle_start, cycle_end, active, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7)
         ON CONFLICT (desk_id) DO UPDATE SET plan=EXCLUDED.plan, monthly_leads=EXCLUDED.monthly_leads, monthly_price=EXCLUDED.monthly_price,
           cycle_start=EXCLUDED.cycle_start, cycle_end=EXCLUDED.cycle_end, pending_plan=NULL, active=true, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [deskId, def.id, def.leads, def.price, s, addMonth(s), user.email]);
      const b = await balances(c, deskId);
      if (b.plan || b.rollover) {
        if (b.plan) await ledger(c, deskId, { bucket: "plan", kind: "adjustment", qty: -b.plan, user, note: "Plan restarted" });
        if (b.rollover) await ledger(c, deskId, { bucket: "rollover", kind: "adjustment", qty: -b.rollover, user, note: "Plan restarted" });
      }
      await ledger(c, deskId, { bucket: "plan", kind: "allocation", qty: def.leads, user, note: `${PLANS[def.id] ? PLANS[def.id].name : "Custom"} plan started` });
      await linkStripe();
    }
  });
  ping(deskId);
  return status(deskId);
}

// Replacement for a bad lead (credit back one), or any manual correction (+/-), always with a reason.
async function credit(deskId, { qty, note, signalId, kind }, user) {
  qty = Math.round(+qty);
  if (!qty || Math.abs(qty) > 100) throw fail("invalid_argument", "Give a number of leads to add or remove");
  if (!String(note || "").trim()) throw fail("invalid_argument", "Add a reason so the history makes sense");
  await tx(async (c) => {
    const p = await lockPlan(c, deskId);
    if (!p) throw fail("invalid_argument", "This desk has no plan yet");
    await renew(c, p);
    await ledger(c, deskId, { bucket: "plan", kind: kind === "replacement" ? "replacement" : "adjustment", qty, signalId, user, note: String(note).trim().slice(0, 300) });
  });
  ping(deskId);
  return status(deskId);
}

async function history(deskId, limit = 100) {
  const r = await pool.query(
    "SELECT id, bucket, kind, qty, signal_id, company, user_name, note, created_at FROM lead_ledger WHERE desk_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [deskId, Math.min(+limit || 100, 500)]);
  return r.rows;
}
async function purchases(deskId, limit = 50) {
  const r = await pool.query("SELECT * FROM lead_purchases WHERE desk_id=$1 ORDER BY created_at DESC LIMIT $2", [deskId, limit]);
  return r.rows;
}

// HQ view: every desk with a plan, and the purchases waiting to be invoiced
async function overview() {
  const desks = (await pool.query("SELECT desk_id FROM desk_plans WHERE active ORDER BY desk_id")).rows;
  const out = [];
  for (const d of desks) out.push({ deskId: d.desk_id, ...(await status(d.desk_id)) });
  const toInvoice = (await pool.query("SELECT * FROM lead_purchases WHERE invoice_status='to_invoice' ORDER BY created_at")).rows;
  return { plans: out, toInvoice };
}
async function setInvoice(id, invoiceStatus, user) {
  if (!["to_invoice", "invoiced", "waived", "paid"].includes(invoiceStatus)) throw fail("invalid_argument", "Unknown invoice status");
  const r = await pool.query(
    "UPDATE lead_purchases SET invoice_status=$2, invoiced_at=CASE WHEN $2='to_invoice' THEN NULL ELSE now() END, invoiced_by=$3 WHERE id=$1 AND kind IN ('topup','upgrade') RETURNING desk_id",
    [id, invoiceStatus, user.email]);
  if (!r.rowCount) throw fail("not_found", "No such purchase");
  ping(r.rows[0].desk_id);
}

async function raw(deskId) { return (await pool.query("SELECT * FROM desk_plans WHERE desk_id=$1", [deskId])).rows[0] || null; }
async function setBillingStatus(subscriptionId, status) {
  const r = await pool.query("UPDATE desk_plans SET billing_status=$2, updated_at=now() WHERE stripe_subscription_id=$1 RETURNING desk_id", [subscriptionId, status]);
  r.rows.forEach((x) => ping(x.desk_id));
  return r.rows[0]?.desk_id || null;
}

module.exports = { raw, setBillingStatus, LOW_SHARE, PLANS, ORDER, TOPUP_PRICE, TOPUP_BLOCKS, deskOf, status, accept, topup, upgrade, scheduleChange, setPlan, credit, history, purchases, overview, setInvoice, addMonth, torontoToday };
