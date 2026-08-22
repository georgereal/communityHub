# Classic app (archived)

The original CommunityHub SPA (Supabase Postgres, single-page app) lives here for reference and v2.0 rollback.

**Not deployed on Vercel.** Production serves only the New MPAs under `apps/new/` (`/home`, `/admin`, `/finance/…`).

## Layout

| Path | Purpose |
|------|---------|
| `src/` | Classic SPA modules (also re-exported via `@classic` alias for shared helpers) |
| `api/` | Legacy Postgres serverless handlers (not mounted at repo root `api/` except `storage.js`) |
| `sql/` | Supabase SQL migrations used by classic |
| `index.html` | Classic SPA entry (local/archive only) |

## Local dev (optional)

From repo root, the main dev server (`npm run dev`) routes `/` to New home. Classic assets are still served at `/classic/src/…` for login/auth shims in `packages/auth/`.

To run the classic SPA locally, open `/classic/index.html` via Vite’s file path or add a dedicated script if needed.

## Revert

Tag `v2.0` on git preserves the last dual-app deploy. To restore classic on Vercel, re-add `index.html` to `viteAppLayout.js` `HTML_ENTRIES` and classic API shims under `api/`.
