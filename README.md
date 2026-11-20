# TutorLagbe API

Run `npm run dev` from this repository. For production, run `npm run build` followed by `npm start`. Run `npm test` for the local HTTP integration tests and `npm run typecheck` for TypeScript checks.

| Setting | Purpose |
| --- | --- |
| `PORT` | HTTP port. Defaults to `8000`. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated, exact frontend origins such as `https://app.example.com`. Development defaults to `http://localhost:3000` and `http://127.0.0.1:3000`. Production defaults to an empty allowlist. |
| `MONGODB_URI` | Server-only MongoDB connection string for readiness checks. The public liveness endpoint works without it. |

`GET /` reports HTTP liveness. `GET /readyz` returns `200` when MongoDB answers a ping or `503` when it is unavailable or unconfigured. Supply configuration through your shell or hosting platform and keep secret values out of version control.

Better Auth remains on the Next.js origin at `/api/auth`. The Express endpoints are public and use no auth cookies. Configure `BETTER_AUTH_URL` for the origin hosting Next.js. The API scripts use `api/start.ts` and `tsconfig.api.json`. The older files under `src/` are inactive scaffolding.
