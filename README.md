# TutorLagbe API

Run `npm run dev` from this repository. For production, run `npm run build` followed by `npm start`. Run `npm test` for the local HTTP integration tests and `npm run typecheck` for TypeScript checks.

When both repositories are in the TutorLagbe workspace, `node scripts/dev.mjs` from the workspace root starts them together for local development. It reuses existing auth settings and configures the Next.js proxy in the child process environment. The launcher waits for MongoDB readiness and leaves local environment files untouched.

| Setting | Purpose |
| --- | --- |
| `PORT` | HTTP port. Defaults to `8000`. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated, exact frontend origins such as `https://app.example.com`. Development defaults to `http://localhost:3000` and `http://127.0.0.1:3000`. Production defaults to an empty allowlist. |
| `MONGODB_URI` | Server-only MongoDB connection string for the tuition catalog and readiness checks. The catalog can also use `BETTER_AUTH_DB_URI` when this setting is absent. |
| `BETTER_AUTH_DB_URI` | MongoDB connection string for auth. Falls back to `MONGODB_URI` when auth is configured. Use the existing auth database to preserve accounts. |
| `BETTER_AUTH_URL` | Public Next.js origin, for example `http://localhost:3000` in development. Use HTTPS in production. |
| `BETTER_AUTH_SECRET` | Server-only Better Auth secret of at least 32 characters. Reuse the existing auth secret for session continuity. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google provider settings. Supply both to enable it. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server-only Stripe API key and webhook signing secret. Supply both to enable billing. |
| `IMGBB_API_KEY` | Server-only ImgBB key. Set it in the Express environment or local server `.env` to enable image uploads. |

`GET /` reports HTTP liveness. `GET /readyz` returns `200` when all configured MongoDB connections answer a ping or `503` when a database is unavailable or unconfigured. Supply configuration through your shell or hosting platform and keep secret values out of version control.

## Auth cutover

1. Configure the Express service with the same database, public origin, and secret used by the existing Next.js auth service. Verify `/readyz` before switching traffic.
2. Set the server-only `TUTORLAGBE_API_URL` on the Next.js service to the Express origin, for example `http://localhost:8000`. Browser requests stay on the Next.js origin, where `/api/auth/*` forwards cookies and requests to Express. An unset value keeps the legacy Next.js handler active during rollout.
3. Verify registration, sign-in, reload, and sign-out. For protected calls, obtain a five-minute JWT with `authClient.token()` and send it as `Authorization: Bearer <token>` to `/api/auth/identity` through the Next.js origin. Keep the token in memory. Identity and role checks use the active session and current database role.

Auth keeps the existing `tutorlagbe_db` and Better Auth collection names for compatibility. Better Auth stores accounts, sessions, verification records, and JWT keys separately from application collections. A migration from `user` to the assignment's `users` collection still needs to be planned with existing data in mind.

The API scripts use `api/start.ts` and `tsconfig.api.json`. The older files under `src/` are inactive scaffolding.

`GET /api/teachers?page=1` returns public Tutor directory entries in pages of 24. Each entry includes the account ID, name, and any profile photo or bio.

## Image uploads

Send `POST /api/uploads` with a Better Auth bearer token and one multipart file in the `image` field. The server accepts JPEG, PNG, and WebP signatures up to 3 MB (3,145,728 bytes) and returns `201` with `{ "imageUrl": "https://i.ibb.co/..." }`. The client uploads through its same-origin proxy and uses that URL when saving a profile or tuition.

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

## Stripe Pro billing

1. Configure the Stripe settings in the Express process and keep the Next.js `TUTORLAGBE_API_URL` pointed at Express. Billing uses the same MongoDB database as Better Auth and needs transaction support. Use Stripe test mode for the first run.
2. In Stripe, send `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `customer.subscription.paused` to the Express `POST /api/payments/webhook` endpoint. For local testing, forward the same events with Stripe CLI and use the signing secret it provides.
3. Enable the Stripe Customer Portal for payment-method management and cancellation. Keep plan switching and discounts disabled for this integration. Checkout uses fixed monthly prices of USD $10 for students and $15 for teachers.
4. Open `/pricing` with a student or teacher account and complete a test checkout. Verify the payment result, Pro status in the profile, and the invoice under `/dashboard/admin/transactions`. Cancelling a subscription at period end keeps access until Stripe reports that the subscription has ended.

Express verifies Stripe signatures against the raw request body, retrieves the invoice and subscription from Stripe, and records each paid invoice once. The payment record and plan update use a MongoDB transaction. The payment result page only reads status for the signed-in account.
