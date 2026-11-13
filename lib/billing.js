// Stripe: subscriptions for the plans, card payment for top-ups, immediate upgrades, and the webhook that
// turns payments into leads. Off unless STRIPE_SECRET_KEY is set; then the desk falls back to
// "Hyperweb invoices you" (purchases land in Admin > Plans and billing as To invoice).
// Products and prices are created once by scripts/stripe-setup.js and found here by lookup key.
const plans = require("./plans");
const { pool } = require("./db");

const KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = KEY ? require("stripe")(KEY) : null;
const CURRENCY = "cad";
const LOOKUP = {
  starter: "shq_plan_starter_monthly",
  growth: "shq_plan_growth_monthly",
  scale: "shq_plan_scale_monthly",
  setup: "shq_setup_fee",
  setup_pilot: "shq_setup_fee_pilot",
  lead: "shq_extra_lead",
};
const autoTax = () => (process.env.STRIPE_AUTOMATIC_TAX === "true" ? { automatic_tax: { enabled: true } } : {});
const taxRates = () => (process.env.STRIPE_TAX_RATE_ID ? [process.env.STRIPE_TAX_RATE_ID] : undefined);

const fail = (code, message) => Object.assign(new Error(message), { code });
const enabled = () => !!stripe;
const cents = (n) => Math.round(+n * 100);
const who = (u) => ({ user_id: String(u.id || ""), user_name: String(u.name || u.email || "").slice(0, 100) });

let priceCache = null, priceAt = 0;
async function prices() {
  if (priceCache && Date.now() - priceAt < 10 * 60e3) return priceCache;
  const r = await stripe.prices.list({ lookup_keys: Object.values(LOOKUP), active: true, limit: 20 });
  const by = {};
  for (const p of r.data) for (const [k, v] of Object.entries(LOOKUP)) if (p.lookup_key === v) by[k] = p.id;
  const missing = ["starter", "growth", "scale", "setup", "lead"].filter((k) => !by[k]);
  if (missing.length) throw fail("unavailable", `Stripe prices missing (${missing.join(", ")}). Run scripts/stripe-setup.js.`);
  priceCache = by; priceAt = Date.now();
  return by;
}

// New subscription: the plan, monthly, plus the one-time setup fee on the first invoice.
// setup: "full" (default), "pilot" (half price) or "none". Only the Hyperweb team can change it.
async function subscribe(deskId, plan, user, base, setup = "full") {
  if (!plans.PLANS[plan]) throw fail("invalid_argument", "Pick Starter, Growth or Scale");
  const cur = await plans.raw(deskId);
  if (cur && cur.active && cur.stripe_subscription_id) throw fail("invalid_argument", "This desk already has a subscription. Upgrade or manage billing instead.");
  const p = await prices();
  const line_items = [{ price: p[plan], quantity: 1, tax_rates: taxRates() }];
  if (setup === "full") line_items.push({ price: p.setup, quantity: 1, tax_rates: taxRates() });
  if (setup === "pilot" && p.setup_pilot) line_items.push({ price: p.setup_pilot, quantity: 1, tax_rates: taxRates() });
  const meta = { desk_id: deskId, plan, kind: "subscribe", ...who(user) };
  const s = await stripe.checkout.sessions.create({
    mode: "subscription", line_items,
    ...(cur?.stripe_customer_id ? { customer: cur.stripe_customer_id } : { customer_email: user.email }),
    client_reference_id: deskId, metadata: meta, subscription_data: { metadata: meta },
    allow_promotion_codes: true, billing_address_collection: "required", ...autoTax(),
    success_url: `${base}/desk/${encodeURIComponent(deskId)}?billing=subscribed`,
    cancel_url: `${base}/desk/${encodeURIComponent(deskId)}?billing=cancelled`,
  });
  return { url: s.url };
}

async function topup(deskId, block, user, base) {
  block = +block;
  if (!plans.TOPUP_BLOCKS.includes(block)) throw fail("invalid_argument", `Top-ups come in blocks of ${plans.TOPUP_BLOCKS.join(" or ")}`);
  const cur = await plans.raw(deskId);
  if (!cur || !cur.active) throw fail("invalid_argument", "This desk has no plan yet");
  const p = await prices();
  const meta = { desk_id: deskId, kind: "topup", block: String(block), ...who(user) };
  const s = await stripe.checkout.sessions.create({
    mode: "payment", line_items: [{ price: p.lead, quantity: block, tax_rates: taxRates() }],
    ...(cur.stripe_customer_id ? { customer: cur.stripe_customer_id } : { customer_email: user.email, customer_creation: "always" }),
    client_reference_id: deskId, metadata: meta, payment_intent_data: { metadata: meta },
    invoice_creation: { enabled: true, invoice_data: { metadata: meta, description: `Signals HQ: ${block} extra leads` } },
    billing_address_collection: "auto", ...autoTax(),
    success_url: `${base}/desk/${encodeURIComponent(deskId)}?billing=topup`,
    cancel_url: `${base}/desk/${encodeURIComponent(deskId)}?billing=cancelled`,
  });
  return { url: s.url };
}

// Upgrade now: charge the full difference in monthly price on its own invoice, then switch the subscription
// (no proration: the next renewal bills the new plan). If the card needs attention, the client pays the
// hosted invoice and the webhook finishes the upgrade.
async function upgrade(deskId, to, user) {
  const np = plans.PLANS[to];
  const cur = await plans.raw(deskId);
  if (!cur || !cur.active || !cur.stripe_subscription_id) throw fail("invalid_argument", "This desk isn't billed through Stripe");
  if (!np || plans.ORDER.indexOf(to) <= plans.ORDER.indexOf(cur.plan)) throw fail("invalid_argument", "Pick a bigger plan than the current one");
  const amount = cents(np.price - cur.monthly_price);
  const meta = { desk_id: deskId, kind: "upgrade", to, from: cur.plan, ...who(user) };
  const inv = await stripe.invoices.create({
    customer: cur.stripe_customer_id, collection_method: "charge_automatically", auto_advance: false,
    pending_invoice_items_behavior: "exclude", metadata: meta, description: `Signals HQ: upgrade to ${np.name}`,
    default_tax_rates: taxRates(), ...autoTax(),
  });
  await stripe.invoiceItems.create({ customer: cur.stripe_customer_id, invoice: inv.id, currency: CURRENCY, amount, description: `Upgrade ${plans.PLANS[cur.plan]?.name || "plan"} to ${np.name}, this billing cycle (${np.leads - cur.monthly_leads} more leads now)` });
  const fin = await stripe.invoices.finalizeInvoice(inv.id);
  let paid = fin;
  try { paid = await stripe.invoices.pay(inv.id); } catch (e) { paid = await stripe.invoices.retrieve(inv.id); }
  if (paid.status === "paid") { await finishUpgrade(paid); return { status: await plans.status(deskId) }; }
  return { url: paid.hosted_invoice_url, message: "Your card needs attention. Pay the invoice to finish the upgrade." };
}
async function finishUpgrade(inv) {
  const m = inv.metadata || {};
  const cur = await plans.raw(m.desk_id);
  if (!cur || !cur.stripe_subscription_id) return;
  const p = await prices();
  const sub = await stripe.subscriptions.retrieve(cur.stripe_subscription_id);
  const item = sub.items.data[0];
  if (item && item.price.id !== p[m.to]) {
    await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price: p[m.to] }], proration_behavior: "none", metadata: { ...sub.metadata, plan: m.to } });
  }
  await plans.upgrade(m.desk_id, m.to, { id: m.user_id, name: m.user_name }, { paymentRef: inv.id }).catch((e) => { if (!/bigger plan/.test(e.message)) throw e; });
}

// Smaller plan from the next renewal (or cancel that by passing the current plan)
async function change(deskId, to, user) {
  const cur = await plans.raw(deskId);
  const status = await plans.scheduleChange(deskId, to, user);
  if (cur?.stripe_subscription_id) {
    const p = await prices();
    const want = status.pendingPlan || status.plan;
    const sub = await stripe.subscriptions.retrieve(cur.stripe_subscription_id);
    const item = sub.items.data[0];
    if (item && p[want] && item.price.id !== p[want]) await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price: p[want] }], proration_behavior: "none" });
  }
  return status;
}

async function portal(deskId, base) {
  const cur = await plans.raw(deskId);
  if (!cur?.stripe_customer_id) throw fail("invalid_argument", "This desk isn't billed through Stripe");
  const s = await stripe.billingPortal.sessions.create({ customer: cur.stripe_customer_id, return_url: `${base}/desk/${encodeURIComponent(deskId)}` });
  return { url: s.url };
}

// ---------- webhook ----------
async function webhook(raw, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!stripe || !secret) throw fail("unavailable", "Stripe isn't configured");
  let ev;
  try { ev = stripe.webhooks.constructEvent(raw, signature, secret); } catch (e) { throw fail("invalid_argument", "Bad Stripe signature"); }
  const o = ev.data.object, m = o.metadata || {};
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (o.payment_status !== "paid" && o.payment_status !== "no_payment_required") break;
      if (m.kind === "subscribe") {
        const cur = await plans.raw(m.desk_id);
        if (cur && cur.active && cur.stripe_subscription_id === o.subscription) break;
        await plans.setPlan(m.desk_id, { plan: m.plan, stripe: { customer: o.customer, subscription: o.subscription } }, { id: m.user_id || null, name: m.user_name || "Stripe checkout", email: o.customer_details?.email || "" });
        await pool.query(
          `INSERT INTO lead_purchases (desk_id, kind, leads, amount, to_plan, invoice_status, payment_ref, requested_by, requested_by_name)
           VALUES ($1,'subscribe',$2,$3,$4,'paid',$5,$6,$7) ON CONFLICT (payment_ref) DO NOTHING`,
          [m.desk_id, plans.PLANS[m.plan]?.leads || 0, (o.amount_total || 0) / 100, m.plan, o.id, m.user_id || null, m.user_name || ""]);
      } else if (m.kind === "topup") {
        if (o.customer) await pool.query("UPDATE desk_plans SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE desk_id=$1", [m.desk_id, o.customer]);
        await plans.topup(m.desk_id, +m.block, { id: m.user_id || null, name: m.user_name || "Stripe checkout" }, { paymentRef: o.id });
      }
      break;
    }
    case "invoice.paid": {
      if (m.kind === "upgrade") await finishUpgrade(o);
      else if (o.subscription) await plans.setBillingStatus(o.subscription, "ok");
      break;
    }
    case "invoice.payment_failed": {
      if (o.subscription) await plans.setBillingStatus(o.subscription, "past_due");
      break;
    }
    case "customer.subscription.updated": {
      if (["past_due", "unpaid"].includes(o.status)) await plans.setBillingStatus(o.id, "past_due");
      break;
    }
    case "customer.subscription.deleted": {
      const r = await pool.query("SELECT desk_id FROM desk_plans WHERE stripe_subscription_id=$1 AND active", [o.id]);
      for (const row of r.rows) await plans.setPlan(row.desk_id, { plan: "none" }, { name: "Stripe (subscription ended)" });
      break;
    }
  }
  return { received: true, type: ev.type };
}

module.exports = { enabled, subscribe, topup, upgrade, change, portal, webhook, LOOKUP };
