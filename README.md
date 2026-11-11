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
   - `RESEND_API_KEY` and `MAIL_FROM` (e.g. `Signals HQ <signals@hyperweb.ca>`): sends sign-in links. The sending domain must be verified in Resend.
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
lib/gmail.js           Gmail API sender
lib/views.js           sign-in, desk chooser, People and access, page wrapper
pages/hq.html          Signals HQ page
pages/desk.html        Signals Desk page (one copy serves every desk)
public/claude-shim.js  window.claude runtime for the pages
.do/app.yaml           DigitalOcean App Platform spec
```
