# TutorLagbe API

Run `npm run dev` from this repository. For production, run `npm run build` followed by `npm start`. Run `npm test` for the local HTTP integration tests and `npm run typecheck` for TypeScript checks.

| Setting | Purpose |
| --- | --- |
| `PORT` | HTTP port. Defaults to `8000`. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated, exact frontend origins such as `https://app.example.com`. Development defaults to `http://localhost:3000` and `http://127.0.0.1:3000`. Production defaults to an empty allowlist. |
| `MONGODB_URI` | Server-only MongoDB connection string for readiness checks. The public liveness endpoint works without it. |
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
