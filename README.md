# Signals HQ

Hyperweb's managed lead generation desks, served from **signals.hyperweb.ca** instead of claude.ai.

The HQ and desk pages are the same pages that ran as Claude artifacts. A small runtime (`public/claude-shim.js`) gives them the `window.claude.use(...)` API they were built on, backed by this server:

| Page asks for | Served by |
| --- | --- |
| `db` (shared data, live updates) | Postgres, live updates over server-sent events |
| `user` (who's viewing, can they edit) | Email-link sign-in, roles in the `users` table |
| `sample` (asks Claude) | Anthropic API |
| `mcp` Firecrawl | Firecrawl API |
| `mcp` Crunchbase | Crunchbase API v4 (staff only) |
| `mcp` Gmail, Claude Code Remote | Not wired yet (round two). The pages fall back cleanly: runner requests wait for its next pass |

## Who sees what

- **Hyperweb team** (`staff`): HQ, every desk, and People and access. Desks open in team view.
- **Agency partners and clients**: only the desks ticked for them, in client view. "View only" people can look but not change anything.
- Everyone signs in with a one-time link emailed from Gmail. No passwords.

## Deploy on DigitalOcean (one time)

1. **Database.** Databases > Create > PostgreSQL 17, region **Toronto (TOR1)**, smallest plan. Name it `signals-hq-db`.
2. **App.** Apps > Create App > GitHub > `hyperweb/SignalsHQ`, branch `main`. Then Settings > App Spec > Edit, and paste `.do/app.yaml`. This attaches the database, sets the region to Toronto and adds the domain.
3. **Secrets.** In the app's Settings > Environment Variables, fill in each `SECRET`:
   - `RUNNER_TOKEN`: any random string of 40+ characters (e.g. from a password manager). The Claude runner uses it.
   - `RESEND_API_KEY` and `MAIL_FROM` (e.g. `Signals HQ <signals@signals.hyperweb.ca>`): sends sign-in links. The sending domain must be verified in Resend.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (optional, round two): a Google Cloud OAuth client for carl@hyperweb.ca with the `gmail.send` scope, for outreach sent as Carl (steps below).
   - `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, `CRUNCHBASE_API_KEY`.
4. **Domain.** At the registrar for hyperweb.ca, add a `CNAME` record: `signals` pointing to the app's `ondigitalocean.app` address (shown under Settings > Domains). DigitalOcean issues the certificate on its own.
5. **First person.** In the app's Console tab, run:
   `node scripts/add-user.js carl@hyperweb.ca staff "Carl Messenger-Lehmann"`
   Then sign in at signals.hyperweb.ca and add everyone else from **People and access**.

Until `RESEND_API_KEY` is in, sign-in links are written to the app's runtime log instead of emailed.

### Gmail sending (gmail.send)

1. Google Cloud Console > new project "Signals HQ" > enable the **Gmail API**.
2. OAuth consent screen: Internal (Workspace), app name "Signals HQ".
3. Credentials > Create OAuth client ID > Web application. Add `https://developers.google.com/oauthplayground` as a redirect URI.
4. In the OAuth Playground, tick "Use your own OAuth credentials", enter the client ID and secret, authorise `https://www.googleapis.com/auth/gmail.send` as carl@hyperweb.ca, and exchange for a refresh token.

## Moving the data over

`scripts/import.js` loads an export of the claude.ai pages' data (HQ plus each desk) and points desk links at this app. Claude produces the export, so the final move happens at cutover, after which the runner writes here instead.

```
RUNNER_TOKEN=... node scripts/import.js ./export --api https://signals.hyperweb.ca
```

## Runner API

The scheduled Claude runner reads and writes desk data with `Authorization: Bearer $RUNNER_TOKEN`:

| Call | Does |
| --- | --- |
| `GET /api/runner/spaces` | Lists `hq` and every `desk:<id>` |
| `POST /api/runner/query` `{space, coll, where?, orderBy?, limit?}` | Reads a collection, with each doc's `version` |
| `GET /api/runner/doc?space=&path=` | Reads one doc |
| `PUT /api/runner/doc` `{space, path, data, ifVersion?}` | Replaces a doc |
| `PATCH /api/runner/doc` `{space, path, data, ifVersion?}` | Merges into a doc. `{"__delete__": true}` removes a field |
| `DELETE /api/runner/doc?space=&path=&ifVersion=` | Deletes a doc |

`ifVersion` makes a write fail with 409 if someone changed the doc since it was read.

## Signal sources (managed apart from the desks)

**Signal sources** in the top bar (Hyperweb team only) is where every source is managed, whichever client it's for. Desks never hold source settings; they only receive what sources deliver.

| Piece | What it is |
| --- | --- |
| **Catalog** | One record per source: name, UTM code, listening method, config, kind (account, project or market moment), schedule and status |
| **Packs** | Bundles of sources, e.g. Core and the Arborist pack. Tick a pack for a desk and it gets every source in it |
| **Desk access** | Per desk: packs, territory (towns or regions), daily cap, pause. Per desk and source: From packs, On, Hyperweb only or Off, plus parameters (`areas`, `keywords`, `exclude`, a desk's own inbox `query`) |
| **Pool** | Everything a source finds is stored once, de-duplicated, optionally screened by Claude against the source's keep rule, then routed |
| **Activity** | Every run, and where each item went |

**Status lifecycle.** Draft (not running; a manual run fills the pool only) → Testing (runs; delivers as *Hyperweb only*) → Live (clients see it) → Paused or Retired. Setting a source Live releases the held items nobody has acted on.

**Hyperweb only is enforced by the server.** Items marked `hqOnly` are filtered out of every page-data read for partners and clients, can't be changed by them, and never appear in the client tease.

**Listening methods** (configure, don't code): open-data feed (RSS/Atom, GeoJSON or OGC API, ArcGIS, JSON, CSV), page watch, registry compare, alert inbox (Gmail; needs the `gmail.readonly` scope), Claude runner, manual or paid import. The scheduler checks every minute for due feed, page watch, registry and inbox sources; daily, weekly and monthly sources run at 5:40 am Eastern.

**Where items land on a desk.** Account and project signals go to the desk's `signals` collection with `sourceId`, `sourceCode` and `sourceName`, tagged on the card. Market moments go to a `moments` collection and show as their own lane at the top of the Signals tab. Accepting a signal copies `sourceId`, `sourceCode` and UTM values onto the lead, so the scorecard (found, delivered, held, accepted, won) runs per source.

**Seeding.** `npm run seed-sources` loads the Core and Arborist packs from the Maple Hill Tree research and gives the Maple Hill Tree desk both. Re-running it never changes a source's status.

**Runner sources.** The Claude runner asks what's due and pushes what it finds; Signals HQ does the rest:

```
python3 /tmp/shq.py sources-due
python3 /tmp/shq.py push-items facilities-hires @items.json --desk <desk id>
```

| Call | Does |
| --- | --- |
| `GET /api/runner/sources` | The catalog |
| `GET /api/runner/sources/due` | Runner sources that are due, with each desk's territory and parameters |
| `POST /api/runner/sources/:id/items` `{desk?, items, note?}` | Pool, screen and route items |

## Run locally

```
createdb signals
export DATABASE_URL=postgres://localhost/signals APP_URL=http://localhost:8080
npm install
node scripts/add-user.js you@hyperweb.ca staff "Your Name"
npm start
```

## Layout

```
server.js              routes: sign-in, pages, page data API, admin, runner API
lib/store.js           document store (set, merge-update, delete, queries, change events)
lib/auth.js            email-link sign-in, sessions, who can open which desk
lib/connectors.js      Firecrawl, Crunchbase and Claude calls made for the pages
lib/mail.js            sign-in email via Resend (falls back to Gmail, then the log)
lib/gmail.js           Gmail API sender and reader
lib/sources.js         signal source catalog, packs, desk access, routing, scheduler
lib/methods.js         listening methods: feed, page watch, registry, alert inbox
lib/views.js           sign-in, desk chooser, People and access, page wrapper
pages/hq.html          Signals HQ page
pages/desk.html        Signals Desk page (one copy serves every desk)
pages/sources.html     Signal sources page (catalog, packs, desk access, activity)
public/claude-shim.js  window.claude runtime for the pages
.do/app.yaml           DigitalOcean App Platform spec
```
