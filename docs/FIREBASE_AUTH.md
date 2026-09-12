# Auth setup (CommunityHub)

Two sign-in paths share one Mongo identity (`user_id` in `rbac_directory`):

| Method | Where credentials live | Session token |
| --- | --- | --- |
| **Email / password** | Mongo (`password_hash` on `rbac_directory`) | App JWT (`iss=communityhub`, `typ=mongo_session`) via `POST /api/auth-password` |
| **Social** (Google, GitHub, …) | Firebase Auth | Firebase ID token → cookie via `POST /api/auth-session` |

Same email can use either method. Linking keeps the **same `user_id`**, so permissions and data stay identical. Directory fields:

- `auth_methods` — e.g. `password`, `google.com`, `github.com`
- `auth_class` — `local` | `social` | `hybrid`

APIs accept **either** Bearer token type (`getUserFromAuthHeader`).

> **Vercel note:** `firebase-admin` → `jwks-rsa` needs a CJS-compatible `jose`. This repo pins `"overrides": { "jose": "4.15.9" }` so serverless does not throw `ERR_REQUIRE_ESM`.

## 1. Firebase (social only)

1. Open [Firebase Console](https://console.firebase.google.com) → Add project.
2. **Authentication → Sign-in method**: enable **Google**, **GitHub**, etc. (match `VITE_SOCIAL_AUTH_PROVIDERS`). Email/Password in Firebase is **not** required for app login.
3. **Authentication → Settings → Authorized domains**: add your production host and `localhost`.
4. **Project settings → Your apps**: register a Web app; copy config into `VITE_FIREBASE_*` (see [`.env.example`](../.env.example)).
5. **Project settings → Service accounts → Generate new private key**:
   - **Local (recommended):** save as `firebase-service-account.json` in the repo root (gitignored) and set:
     `FIREBASE_SERVICE_ACCOUNT_FILE=./firebase-service-account.json`
   - **Vercel:** do **not** set `FIREBASE_SERVICE_ACCOUNT_FILE` (the file is not in the deploy). Paste the JSON as a **single line** into `FIREBASE_SERVICE_ACCOUNT_JSON`, or use base64 in `FIREBASE_SERVICE_ACCOUNT_BASE64`.
   - Multiline JSON in `.env` is **not** supported and will break social login (redirect loop).
   Set `FIREBASE_PROJECT_ID` to the same project id.

## 2. Email / password (Mongo)

1. Set a strong `AUTH_SESSION_SECRET` (or `JWT_SECRET`) — used to sign Mongo session JWTs.
2. Login / signup: `POST /api/auth-password` with `{ action: 'login'|'signup', email, password }`.
3. If the email already exists as social-only, **Create account** attaches a password to that same `user_id` (`auth_class` → `hybrid`).
4. If the email is social-only and the user tries password login without a hash, they are told to use social or create a password first.

## 3. OAuth provider consoles

- **Google**: Firebase Google provider; ensure the OAuth consent screen allows your domains.
- **GitHub**: create an OAuth App; callback URL is typically `https://<authDomain>/__/auth/handler` (shown in Firebase GitHub provider settings).

## 4. Migrate existing users

```bash
# Directory upsert from Supabase Auth (or profiles fallback)
npm run migrate:auth-firebase

# Dry-run
npm run migrate:auth-firebase -- --dry-run

# Mongo directory only (no Firebase Admin calls)
npm run migrate:auth-firebase -- --mongo-only

# Password hash import: export auth.users (id, email, encrypted_password, raw_*_meta_data)
# from the Supabase SQL editor to JSON, then:
npm run migrate:auth-firebase -- --from-json ./auth_users.json
```

This upserts `rbac_directory` with `user_id = supabase id`, `email`, `legacy_supabase_uid`. Social-only accounts are **not** created in Firebase — users sign in with Google/GitHub once; the server attaches `firebase_uid` by verified email and keeps their permissions. Imported password hashes land on Mongo for email login (not Firebase).

## 5. Local / Vercel env checklist

| Variable | Where |
| --- | --- |
| `AUTH_SESSION_SECRET` (or `JWT_SECRET`) | Server — Mongo email/password sessions |
| `VITE_FIREBASE_*` | Browser — social only |
| `FIREBASE_PROJECT_ID` | Server — social token verify |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Server (local file path — preferred) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server (single-line JSON — Vercel) |
| `MONGODB_URI` / `MONGODB_DB_NAME` | Server (identity + RBAC) |

Email/password login works **without** Firebase if social buttons are unused. Social login needs Firebase Admin + web config. Keep Supabase vars only if Classic Postgres / leftover helpers still run.
