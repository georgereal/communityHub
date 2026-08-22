# AGENTS.md — CommunityHub / ApartmentMaintenance

This file is read by coding agents (Claude Code, Cline, GitHub Copilot, Cursor, Codex, etc.) before every task.

**Project:** ApartmentMaintenance (CommunityHub) — Vite + vanilla JS. Classic SPA on Supabase Postgres; New MPAs on Mongo + Supabase Auth.
**Stack:** Vite · `classic/` (archived) · `apps/new` · `packages/auth` · Vercel `api/*.js` · ExcelJS/PDF/Quill.

---

## CRITICAL: Read the Repository Map Before Coding

**Before starting ANY task that involves planning, exploration, or code changes, you MUST first read:**

```
docs/REPO_MAP.md
```

For **New** app REST / Mongo domains (Finance, Property, Integrations segregation), also read:

```
docs/ARCHITECTURE_NEW.md
```

The repository map is the **single source of truth** for this project's directory structure, feature modules,
API endpoints, views/routes, SQL migrations, architectural patterns, and development commands.

Reading it first:
- Gives you instant context without re-exploring the whole codebase.
- Reveals where features live (`classic/src` archived, `apps/new/src` production, `api/` serverless).
- Surfaces existing patterns (state in `store.js`, routing in `navigation.js`, lazy views in `views/controllers.js`).
- Keeps your work consistent with current conventions.

### Workflow

1. Read `docs/REPO_MAP.md` first.
2. Use its structure to locate the relevant files.
3. Only then explore specific files with `read_file` / `search`.
4. If the repo map is stale or missing sections relevant to your task, update it as part of your changes.

---

## Update the Repo Map on Structural Changes

**Whenever you make any of the following changes, you MUST update `docs/REPO_MAP.md`:**

1. **New / removed files or directories** under `src/`, `api/`, or `scripts/`.
2. **New feature modules** in `src/` (e.g. a new ledger, notices, or portal feature).
3. **New routes / views** — changes to `src/navigation.js` (`NAV_MODULES`) or view dispatch in `src/views/controllers.js`.
4. **New `api/` endpoints** or renaming/removing existing ones.
5. **New npm scripts** in `package.json`.
6. **New SQL migrations** (`supabase_*.sql` at repo root) or `docs/scripts/sql/*`.
7. **New build/config changes** — `vite.config.js`, `vercel.json`, root config files.
8. **Architectural pattern changes** — state, auth, RBAC/access, or data-flow changes.

### Regenerate the Repo Map

```bash
# From the repository root — either of these:
npm run generate-repo-map
node scripts/utilities/generate-repo-map.js
```

### Commit Checklist for Structural Changes

- [ ] Repo map updated (`docs/REPO_MAP.md`) and committed.
- [ ] New/modified files documented in the appropriate section.
- [ ] Route table updated (if routes changed).
- [ ] No stale references to removed files/directories.

---

## Guardrails (enforced automatically)

- **Git pre-push hook** (`.git/hooks/pre-push`, installed via `npm run setup:hooks`): detects structural
  changes (`src/`, `api/`, `scripts/`, `package.json`, `vite.config.js`, `vercel.json`), auto-regenerates the
  repo map, and warns if it is stale. It does **not** block the push.
- **CI (`.github/workflows/repo-map-check.yml`)**: runs on PRs touching structural files, regenerates the map,
  and comments on the PR if it is out of date.

> Even though the hook regenerates the map for you, prefer updating it as part of your change set so the
> committed map reflects your work.
