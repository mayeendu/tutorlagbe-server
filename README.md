# TutorLagbe API

Run `npm run dev` from this repository. For production, run `npm run build` followed by `npm start`. Run `npm test` for the local HTTP integration tests and `npm run typecheck` for TypeScript checks.

| Setting | Purpose |
| --- | --- |
| `PORT` | HTTP port. Defaults to `8000`. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated, exact frontend origins such as `https://app.example.com`. Development defaults to `http://localhost:3000` and `http://127.0.0.1:3000`. Production defaults to an empty allowlist. |
| `MONGODB_URI` | Server-only MongoDB connection string for the tuition catalog and readiness checks. The catalog can also use `BETTER_AUTH_DB_URI` when this setting is absent. |
| `BETTER_AUTH_DB_URI` | MongoDB connection string for auth. Falls back to `MONGODB_URI` when auth is configured. Use the existing auth database to preserve accounts. |
| `BETTER_AUTH_URL` | Public Next.js origin, for example `http://localhost:3000` in development. Use HTTPS in production. |
| `BETTER_AUTH_SECRET` | Server-only Better Auth secret of at least 32 characters. Reuse the existing auth secret for session continuity. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google provider settings. Supply both to enable it. |

`GET /` reports HTTP liveness. `GET /readyz` returns `200` when all configured MongoDB connections answer a ping or `503` when a database is unavailable or unconfigured. Supply configuration through your shell or hosting platform and keep secret values out of version control.

## Auth cutover

1. Configure the Express service with the same database, public origin, and secret used by the existing Next.js auth service. Verify `/readyz` before switching traffic.
2. Set the server-only `TUTORLAGBE_API_URL` on the Next.js service to the Express origin, for example `http://localhost:8000`. Browser requests stay on the Next.js origin, where `/api/auth/*` forwards cookies and requests to Express. An unset value keeps the legacy Next.js handler active during rollout.
3. Verify registration, sign-in, reload, and sign-out. For protected calls, obtain a five-minute JWT with `authClient.token()` and send it as `Authorization: Bearer <token>` to `/api/auth/identity` through the Next.js origin. Keep the token in memory. Identity and role checks use the active session and current database role.

Auth keeps the existing `tutorlagbe_db` and Better Auth collection names for compatibility. Better Auth stores accounts, sessions, verification records, and JWT keys separately from application collections. A migration from `user` to the assignment's `users` collection still needs to be planned with existing data in mind.

The API scripts use `api/start.ts` and `tsconfig.api.json`. The older files under `src/` are inactive scaffolding.

## Tuition publishing

- `GET /api/tuitions` lists approved, active tuitions. Use `q`, `subject`, `classLevel`, `mode`, or `page` to filter results. `GET /api/tuitions/:id` applies the same visibility rules.
- `POST /api/tuitions` creates a pending listing for the authenticated tutor. Free tutors may create two listings. The API creates a partial unique index on the first Free submission, so MongoDB must permit index creation on `tuitions`.
- `GET /api/tuitions/moderation` and `PATCH /api/tuitions/:id/moderation` require an admin JWT. Send `{ "status": "approved" }` or `{ "status": "rejected" }` for a pending listing.
- `GET /api/tuitions/manage` lists a teacher's own tuitions or all tuitions for an admin. `GET`, `PATCH`, and `DELETE /api/tuitions/manage/:id` use the same ownership rules. Teacher edits return a listing to pending review. Moderation clients send the row's `revision` when present to prevent approving a stale edit.
- The Next.js routes are `/dashboard/tutor/post-tuition`, `/dashboard/admin/tuitions`, and `/tuitions`. They use the same `TUTORLAGBE_API_URL` configured for the auth proxy. Provision admin roles through an authorized administrative process. Public sign-up accepts Student and Tutor.

## Profile management

Use `GET /api/profiles/me` to read your own profile and `PATCH /api/profiles/me` to edit your name, phone, bio, or photo URL. Admins can list profiles at `GET /api/profiles` and read, edit, or delete individual profiles at `/api/profiles/:id`. Deletion removes the account and sessions in a MongoDB transaction. It preserves tuition listings for separate management and protects the last admin account.

## Tuition applications

- Students submit `POST /api/applications` with `tuitionId`, `studentPhone`, `preferredSchedule`, and optional `studentNote`. The tuition must be approved and active. The API derives account and listing fields on the server and creates a unique MongoDB index on student ID and tuition ID on first use.
- Students use `GET /api/applications/mine` to track their applications and `DELETE /api/applications/:id` to cancel a pending application. A cancelled application can be submitted again.
- Teachers use `GET /api/applications/received` to see applications to their tuitions and `PATCH /api/applications/:id/status` to accept or reject a pending application. Application contact information is available only through the protected dashboards.
