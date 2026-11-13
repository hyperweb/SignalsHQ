// Loads the starting signal source catalog: the Core pack and the Arborist pack built from the
// Maple Hill Tree Services research (Nov 12, 2026), then gives the Maple Hill Tree desk the Arborist pack.
// Safe to run again: it updates sources and packs by id and never changes a source's status once set.
//
//   node scripts/seed-sources.js              (finds the Maple Hill Tree desk by name)
//   node scripts/seed-sources.js --desk <id>  (or name it)
const { pool, migrate } = require("../lib/db");
const sources = require("../lib/sources");

const OAK_WARDS = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ url: `https://www.oakville.ca/business-development/planning-development/active-development-applications/ward-${n}-development-and-site-plan-applications/`, label: `Oakville Ward ${n} applications`, area: "Oakville" }));

const SOURCES = [
  // ---------- Tier 1: free, shared feeds ----------
  { id: "eccc-severe-weather", name: "Severe weather alerts, Golden Horseshoe", code: "wx-alert", method: "feed", kind: "moment", subject: "area", mode: "shared", status: "Testing", schedule: "hourly",
    segments: ["property managers", "condos", "golf", "cemeteries", "commercial"],
    description: "Environment Canada wind, freezing rain, ice, thunderstorm and snow squall warnings and watches for Hamilton to Mississauga and up to Guelph. A reason to send the storm response message to every property manager the desk knows.",
    cost_note: "Free (Environment Canada GeoMet, Open Government Licence)",
    config: { url: "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&bbox=-80.6,43.0,-79.5,43.8&limit=500", where: [{ field: "alert_type", op: "in", value: "warning,watch" }, { field: "status_en", op: "ne", value: "ended" }, { field: "province", op: "eq", value: "ON" }],
      keywords: "wind,freezing rain,ice,thunderstorm,snow squall,tornado,winter storm", keywordFields: ["alert_name_en"],
      map: { key: "{alert_code}|{feature_id}|{validity_datetime}", title: "{alert_name_en}: {feature_name_en}", detail: "alert_text_en", date: "publication_datetime", area: "feature_name_en", severity: "alert_type", type: "alert_name_en" }, dailyCap: 6 } },
  { id: "canadabuys-tenders", name: "Federal tenders, tree and grounds work (CanadaBuys)", code: "tdr-cb", method: "feed", kind: "account", subject: "public_body", mode: "shared", status: "Testing", schedule: "6h",
    segments: ["public sector"],
    description: "New federal tender notices for tree care, urban forestry, vegetation management and grounds maintenance delivered in Ontario.",
    cost_note: "Free (CanadaBuys open data, refreshed every two hours)",
    config: { url: "https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv", format: "csv",
      where: [{ field: "regionsOfDelivery-regionsLivraison-eng", op: "contains", value: "ontario" }],
      keywords: "tree,arbor,forestry,vegetation,grounds maintenance,landscap,stump,pruning,brush,hedge,invasive",
      keywordFields: ["title-titre-eng", "tenderDescription-descriptionAppelOffres-eng", "gsinDescription-nibsDescription-eng", "unspscDescription-eng"],
      map: { key: "referenceNumber-numeroReference", title: "title-titre-eng", detail: "Closes {tenderClosingDate-appelOffresDateCloture}. {tenderDescription-descriptionAppelOffres-eng}", date: "publicationDate-datePublication", company: "contractingEntityName-nomEntitContractante-eng", area: "regionsOfDelivery-regionsLivraison-eng", url: "noticeURL-URLavis-eng", type: "Tender" } } },
  { id: "oakville-dev-apps", name: "Oakville development and site plan applications", code: "dev-oak", method: "page_watch", kind: "project", subject: "project", mode: "shared", status: "Testing", schedule: "daily",
    segments: ["builders", "developers", "commercial", "multi-unit"],
    description: "New applications posted on Oakville's ward pages. New sites mean tree inventories, protection plans and removals before construction.",
    cost_note: "Free",
    config: { urls: OAK_WARDS, watch: "links", exclude: "facebook,twitter,linkedin,instagram,youtube,mailto",
      screen: { keepIf: "A specific new development, site plan, rezoning, subdivision or condominium application or file for a property. Drop navigation links, general town pages and anything where the applicant is a private homeowner." } } },
  { id: "mississauga-permits", name: "Mississauga issued building permits", code: "bp-mis", method: "feed", kind: "project", subject: "property", mode: "shared", status: "Draft", schedule: "daily",
    segments: ["commercial", "multi-unit", "builders"],
    description: "Newly issued commercial, industrial and multi-unit building permits. Needs the ArcGIS layer address from data.mississauga.ca (Issued Building Permits) before it can run.",
    cost_note: "Free (City of Mississauga open data)",
    config: { url: "", where: [], keywords: "new,addition,demolition", map: { key: "_id", title: "{ADDRESS}", detail: "{DESCRIPTION}", date: "ISSUE_DATE", area: "Mississauga", type: "Building permit" }, notes: "Paste the FeatureServer layer query URL, e.g. .../FeatureServer/0/query?where=1%3D1&outFields=*&orderByFields=ISSUE_DATE+DESC&resultRecordCount=200&f=json, then check the field names after a Draft run." } },
  { id: "burlington-permits", name: "Burlington building permits", code: "bp-bur", method: "feed", kind: "project", subject: "property", mode: "shared", status: "Draft", schedule: "daily",
    segments: ["commercial", "multi-unit", "builders"],
    description: "Burlington building permits from Navigate Burlington open data. Needs the ArcGIS layer address before it can run.",
    cost_note: "Free (City of Burlington open data)",
    config: { url: "", map: { key: "_id", area: "Burlington", type: "Building permit" }, notes: "Dataset: navburl-burlington.opendata.arcgis.com, Building Permits. Paste its FeatureServer query URL." } },
  { id: "tender-alert-inbox", name: "Municipal tender alerts (bids&tenders inbox)", code: "tdr-bt", method: "alert_inbox", kind: "account", subject: "public_body", mode: "per_desk", status: "Draft", schedule: "6h",
    segments: ["public sector", "educational"],
    description: "Reads the desk's tender-alert inbox (bids&tenders vendor alerts for Halton, Peel, Hamilton and school boards) and pulls out each notice.",
    cost_note: "Free. Needs a dedicated inbox and the gmail.readonly scope.",
    config: { query: "newer_than:3d", keywords: "tree,arbor,forestry,vegetation,grounds,landscap,stump,pruning,urban forest", notes: "Set the desk's own query on Desk access, e.g. {\"query\":\"to:signals-maplehill@hyperweb.ca newer_than:3d\"}." } },
  { id: "committee-of-adjustment", name: "Committee of Adjustment agendas, corporate applicants", code: "coa", method: "page_watch", kind: "project", subject: "project", mode: "shared", status: "Draft", schedule: "weekly",
    segments: ["builders", "developers"],
    description: "Minor variance and consent applications. Only corporate applicants, developers and builders pass through; homeowners are screened out.",
    cost_note: "Free",
    config: { urls: [], watch: "links", keywords: "agenda,application,variance,consent", screen: { keepIf: "The applicant is a company, developer, builder or public body. Never pass an application by a private individual or homeowner." }, notes: "Add each town's Committee of Adjustment agenda page." } },
  { id: "pest-notices", name: "Pest and tree health notices (CFIA and municipal)", code: "pest", method: "page_watch", kind: "moment", subject: "area", mode: "shared", status: "Draft", schedule: "weekly",
    segments: ["property managers", "golf", "cemeteries", "condos"],
    description: "Spongy moth, emerald ash borer, oak wilt and similar notices. A reason to offer inspections to a whole segment.",
    cost_note: "Free",
    config: { urls: [], watch: "text", keywords: "spongy moth,ash borer,oak wilt,beech leaf,asian longhorned,quarantine,spray,treatment program", notes: "Add the CFIA regulated pests page and each town's forestry or pest page." } },
  // ---------- Tier 2 ----------
  { id: "condo-registry", name: "Ontario condominium registry, management changes", code: "cao-reg", method: "registry", kind: "account", subject: "property", mode: "shared", status: "Draft", schedule: "monthly",
    segments: ["condos", "property managers"],
    description: "Monthly comparison of the Condominium Authority of Ontario public registry. A new property manager on a condo corporation is the time to meet them. Contact goes through the management company, never board members' personal details.",
    cost_note: "Free. Needs an export or table address from the registry.",
    config: { url: "", format: "csv", map: { key: "Corporation Number", title: "{Corporation Name}", detail: "Managed by {Management Company}", company: "Management Company", area: "City" }, watchFields: ["Management Company"], notes: "The CAO registry is searched one corporation at a time. Point this at an export we're given, or switch it to the runner." } },
  { id: "facilities-hires", name: "Facilities and superintendent hires", code: "ppl-fac", method: "runner", kind: "account", subject: "company", mode: "per_desk", status: "Testing", schedule: "weekly",
    segments: ["golf", "commercial", "educational", "property managers"],
    description: "New facilities managers, golf course superintendents, grounds managers and property managers at organizations in the desk's territory.",
    cost_note: "SeamlessAI or RocketReach credits per contact; job boards free",
    config: { instructions: "For each desk listed, find people who started in the last 30 days as facilities manager, director of facilities, grounds or golf course superintendent, or property manager at organizations in the desk's areas (Seamless.AI or RocketReach job-change search, OGSA and job boards). Push one item per organization: company, area, title (\"New superintendent: <name>\"), detail (role and start month), url (public source), date. Never push personal emails or phone numbers as items.", tools: "SeamlessAI, RocketReach, Firecrawl search" } },
  { id: "property-deals", name: "Property sales and REIT deals", code: "news-prop", method: "runner", kind: "account", subject: "property", mode: "shared", status: "Testing", schedule: "weekly",
    segments: ["commercial", "multi-unit", "property managers"],
    description: "Commercial and multi-unit property sales, REIT acquisitions and new owners in Halton, Peel, Hamilton and Waterloo Region. A new owner reviews every contractor.",
    cost_note: "Firecrawl search credits",
    config: { instructions: "Search news from the last 7 days for sales of commercial, industrial, multi-unit or golf properties and REIT acquisitions in Halton, Peel, Hamilton, Guelph and Waterloo Region. One item per deal: company (the buyer or new owner), area, title, detail (property and price if stated), url, date.", tools: "Firecrawl search" } },
  { id: "golf-cemetery-projects", name: "Golf course and cemetery projects", code: "news-golf", method: "runner", kind: "account", subject: "company", mode: "shared", status: "Draft", schedule: "monthly",
    segments: ["golf", "cemeteries"],
    description: "Course renovations, expansions, new ownership, and cemetery expansions or new licences (Bereavement Authority of Ontario).",
    cost_note: "Firecrawl search credits",
    config: { instructions: "Find golf course renovations, bunker or tree work, new owners or clubhouse projects, and cemetery expansions or new licences in the territory, from the last 60 days.", tools: "Firecrawl search" } },
  // ---------- Tier 3 ----------
  { id: "tree-review-mining", name: "Tree complaints in property reviews", code: "rev-tree", method: "runner", kind: "account", subject: "property", mode: "per_desk", status: "Draft", schedule: "monthly",
    segments: ["condos", "multi-unit", "property managers"],
    description: "Google reviews of apartment and condo properties that mention fallen trees, branches, roots or overgrown grounds.",
    cost_note: "OpenSEO credits",
    config: { instructions: "For the desk's areas, look up reviews of apartment buildings, condos and plazas that mention trees, branches, roots, leaves or overgrown grounds in the last 90 days. One item per property: company (the property or its manager), area, detail (the issue in your own words, no quotes), url (the listing).", tools: "OpenSEO" } },
  { id: "municipal-tree-programs", name: "Tree bylaw, urban forest and funding changes", code: "muni-tree", method: "page_watch", kind: "moment", subject: "public_body", mode: "shared", status: "Draft", schedule: "monthly",
    segments: ["public sector", "property managers"],
    description: "Changes to private tree bylaws and urban forest plans, Green Municipal Fund and Trillium grants for tree planting. Moments to update clients and reach municipalities.",
    cost_note: "Free",
    config: { urls: [], watch: "text", keywords: "tree,urban forest,canopy,planting,bylaw", notes: "Add each town's tree bylaw page and the Green Municipal Fund funded projects page." } },
  { id: "paid-property-data", name: "Paid property data import (Altus, CoStar)", code: "imp-prop", method: "manual", kind: "account", subject: "property", mode: "shared", status: "Draft", schedule: "manual",
    segments: ["commercial", "multi-unit"],
    description: "Paste an export from Altus, CoStar or Sales Navigator. Held as Draft until the free sources show conversions.",
    cost_note: "Subscription", config: {} },
];

const PACKS = [
  { id: "core", name: "Core", description: "Sources every desk can use: hires and property deals.", sources: ["facilities-hires", "property-deals"] },
  { id: "arborist", name: "Arborist pack", description: "Tree care and grounds: development applications, permits, tenders, storm and pest moments, condo registries, review mining.",
    sources: ["eccc-severe-weather", "canadabuys-tenders", "oakville-dev-apps", "mississauga-permits", "burlington-permits", "tender-alert-inbox", "committee-of-adjustment", "pest-notices", "condo-registry", "golf-cemetery-projects", "tree-review-mining", "municipal-tree-programs", "paid-property-data"] },
];

(async () => {
  await migrate();
  for (const s of SOURCES) {
    const cur = await sources.getSource(s.id);
    await sources.saveSource({ ...s, status: cur ? cur.status : s.status }, "seed");
    console.log(`${cur ? "updated" : "added"}  ${s.id}  (${cur ? cur.status : s.status})`);
  }
  for (const p of PACKS) { await sources.savePack(p); console.log(`pack    ${p.id}  (${p.sources.length} sources)`); }
  const i = process.argv.indexOf("--desk");
  let desk = i > 0 ? process.argv[i + 1] : null;
  if (!desk) desk = (await sources.desks()).find((d) => /maple\s*hill/i.test(d.name))?.id || null;
  if (desk) {
    const cur = (await pool.query("SELECT pack_id FROM desk_packs WHERE desk_id=$1", [desk])).rows.map((r) => r.pack_id);
    await sources.setDeskPacks(desk, [...new Set([...cur, "core", "arborist"])]);
    const set = (await pool.query("SELECT 1 FROM desk_signal_settings WHERE desk_id=$1", [desk])).rowCount;
    if (!set) await sources.setDeskSettings(desk, { areas: "Mississauga, Oakville, Burlington, Milton, Hamilton, Halton, Peel", daily_cap: 25 }, "seed");
    console.log(`desk    ${desk}  gets Core and the Arborist pack`);
  } else console.log("No Maple Hill Tree desk found. Run again with --desk <id>, or tick the packs on Desk access.");
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
