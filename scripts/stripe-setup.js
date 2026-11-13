// One-time Stripe setup: creates the Signals HQ products and prices (CAD) that lib/billing.js looks up by key.
// Safe to run again: anything that already exists with the right amount is left alone.
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.js          (test mode first)
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.js          (then live)
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "");
const { LOOKUP } = require("../lib/billing");

const ITEMS = [
  { key: "starter", product: "Signals HQ Starter", desc: "10 qualified leads a month", amount: 950, recurring: true },
  { key: "growth", product: "Signals HQ Growth", desc: "25 qualified leads a month", amount: 2000, recurring: true },
  { key: "scale", product: "Signals HQ Scale", desc: "50 qualified leads a month", amount: 3500, recurring: true },
  { key: "setup", product: "Signals HQ setup", desc: "Account creation, signal sources, ideal customer profile import and dashboard configuration", amount: 1500 },
  { key: "setup_pilot", product: "Signals HQ setup (pilot)", desc: "Introductory pilot setup, half price", amount: 750 },
  { key: "lead", product: "Signals HQ extra leads", desc: "Extra qualified leads, sold in blocks of 5 or 10", amount: 125 },
];

(async () => {
  if (!process.env.STRIPE_SECRET_KEY) { console.error("Set STRIPE_SECRET_KEY first"); process.exit(1); }
  const mode = process.env.STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "test";
  console.log(`Stripe ${mode} mode`);
  const existing = await stripe.prices.list({ lookup_keys: ITEMS.map((i) => LOOKUP[i.key]), limit: 20, expand: ["data.product"] });
  for (const it of ITEMS) {
    const lk = LOOKUP[it.key];
    const have = existing.data.find((p) => p.lookup_key === lk);
    if (have && have.unit_amount === it.amount * 100 && have.currency === "cad" && have.active) { console.log(`ok      ${it.product}  ${lk}  ${have.id}`); continue; }
    let productId = have?.product?.id;
    if (!productId) {
      const prod = await stripe.products.create({ name: it.product, description: it.desc, metadata: { app: "signals-hq", key: it.key }, tax_code: "txcd_10000000" });
      productId = prod.id;
    }
    const price = await stripe.prices.create({
      product: productId, currency: "cad", unit_amount: it.amount * 100, lookup_key: lk, transfer_lookup_key: true,
      tax_behavior: "exclusive", ...(it.recurring ? { recurring: { interval: "month" } } : {}), metadata: { app: "signals-hq", key: it.key },
    });
    console.log(`${have ? "updated" : "created"} ${it.product}  ${lk}  ${price.id}  $${it.amount}${it.recurring ? "/month" : ""}`);
  }
  console.log("\nNext: add a webhook endpoint at https://signals.hyperweb.ca/api/stripe/webhook for:");
  console.log("  checkout.session.completed, checkout.session.async_payment_succeeded, invoice.paid,");
  console.log("  invoice.payment_failed, customer.subscription.updated, customer.subscription.deleted");
  console.log("and put its signing secret in STRIPE_WEBHOOK_SECRET.");
})().catch((e) => { console.error(e.message); process.exit(1); });
