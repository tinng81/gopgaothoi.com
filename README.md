# gopgaothoi.com

Fully serverless deployment of the wedding invitation: static files only
(`site/`), with guest submissions (RSVP + wishes) collected by Cloudflare
Pages Functions (`functions/api/`) into Cloudflare D1. No backend, no Strapi
at runtime. Live at https://gopgaothoi-com.pages.dev.

| Path | What it is |
|---|---|
| `site/` | Static export of the invitation (index.html + engine assets + uploads). Built with luban-h5 `scripts/build-site.mjs`. |
| `functions/api/rsvp.js` | `POST /api/rsvp` submit · `GET /api/rsvp?work=<id>&format=json\|csv` (admin) |
| `functions/api/wish.js` | `POST /api/wish` submit · `GET /api/wish?work=<id>&format=json\|csv` (admin) |
| `schema.sql` | D1 tables `rsvps` + `wishes` (+ indexes) |
| `wrangler.toml` | Config-as-code: project name, output dir, D1 binding (`DB` → `rsvp-db`). Applied on every push. |

Every push to `main` triggers a Cloudflare Pages build. There is nothing to
compile: build command stays **empty**, output directory is **`site`**, and
`functions/` is bundled automatically by Pages. (If you chose Path A, the
`pages_build_output_dir` in `wrangler.toml` pins the output directory.)

KV is intentionally not used — D1 covers both RSVP and wishes (relational
rows + CSV export).

## One-time wiring (D1)

The Cloudflare CLI is `wrangler` — `npm install -g wrangler` once, or just
prefix every command below with `npx` (auto-downloads on first use).

1. **Login:** `npx wrangler login` (opens the browser for OAuth), then
   `npx wrangler whoami` to confirm.
2. **Create the database:** `npx wrangler d1 create rsvp-db`
   → note the printed `database_id` (a UUID).
3. **Create the tables:**
   `npx wrangler d1 execute rsvp-db --remote --file=schema.sql`
   (all statements are `CREATE ... IF NOT EXISTS`, safe to re-run)
4. **Bind the database to the Pages project — done, via config-as-code:**
   `wrangler.toml` is committed with the project name, the output dir and
   the D1 binding (`DB` → `rsvp-db`); every push applies it. If you ever
   prefer dashboard-managed bindings instead, delete `wrangler.toml` and
   set the binding by hand: Workers & Pages → this project → Settings →
   Bindings → D1.
5. **Admin secret — done:** `ADMIN_KEY` is uploaded as an encrypted secret
   (`npx wrangler pages secret put ADMIN_KEY --project-name=gopgaothoi-com`,
   value generated with `openssl rand -hex 32`). It guards reading
   submissions; it is never committed. Re-run the command (or Dashboard →
   Settings → Variables → Encrypt) to rotate it.
6. **Verify the schema:**
   `npx wrangler d1 execute rsvp-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`

## Reading submissions

```bash
KEY=<ADMIN_KEY value>
BASE=https://<project-name>.pages.dev

# RSVP — JSON or CSV:
curl -H "x-admin-key: $KEY" "$BASE/api/rsvp?work=53"
curl -H "x-admin-key: $KEY" "$BASE/api/rsvp?work=53&format=csv" -o rsvp.csv

# Wishes:
curl -H "x-admin-key: $KEY" "$BASE/api/wish?work=53&format=csv" -o wishes.csv
```

## Updating site content

In the luban-h5 repo, regenerate and copy over:

```bash
node scripts/build-site.mjs <workId> --api-base https://<strapi-host>
rm -rf site && cp -R /path/to/luban-h5/site .
git add site && git commit -m "chore: refresh site export" && git push
```

`functions/` and `schema.sql` rarely change.

## Local development

```bash
npx wrangler d1 execute rsvp-db --local --file=schema.sql
npx wrangler pages dev site --d1 DB=rsvp-db
```

Submissions land in a local D1 replica; production is untouched.

## Custom domain

Pages → project → Custom domains → add `gopgaothoi.com` (and `www`),
following Cloudflare's DNS prompts. Functions (`/api/*`) work identically on
the custom domain and on `<project-name>.pages.dev`.
