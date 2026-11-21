# TutorLagbe API

Run `npm run dev` from this repository. For production, run `npm run build` followed by `npm start`. Run `npm test` for the local HTTP integration tests and `npm run typecheck` for TypeScript checks.

Run `npm run seed:tuitions` against the configured database to populate an underfilled catalog with 12 approved listings linked to six sample teacher profiles. The command uses stable IDs, preserves existing records, and skips catalogs that already have at least 12 active, approved listings linked to tutors across at least eight subjects. Use `npm run seed:tuitions -- --check` to check the threshold without writing records. Sample profiles have no login credentials.

When both repositories are in the TutorLagbe workspace, `node scripts/dev.mjs` from the workspace root starts them together for local development. It reuses existing auth settings and configures the Next.js proxy in the child process environment. The launcher waits for MongoDB readiness and leaves local environment files untouched.

For separate `npm run dev` processes in this workspace, Next.js defaults to Express on `http://127.0.0.1:8000` when `TUTORLAGBE_API_URL` is unset. Express uses the sibling client's local Better Auth settings when Express has neither database URI configured. Set `TUTORLAGBE_API_URL` explicitly if Express uses a different port. Production uses the settings of each deployed service.

| Setting | Purpose |
| --- | --- |
| `PORT` | HTTP port. Defaults to `8000`. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated, exact frontend origins such as `https://app.example.com`. Development defaults to `http://localhost:3000` and `http://127.0.0.1:3000`. Production defaults to an empty allowlist. |
| `MONGODB_URI` | Server-only MongoDB connection string for the tuition catalog and readiness checks. The catalog can also use `BETTER_AUTH_DB_URI` when this setting is absent. |
| `BETTER_AUTH_DB_URI` | MongoDB connection string for auth. Falls back to `MONGODB_URI` when auth is configured. Use the existing auth database to preserve accounts. |
| `BETTER_AUTH_URL` | Public Next.js origin, for example `http://localhost:3000` in development. Use HTTPS in production. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional comma-separated, exact alternate frontend origins. Use HTTPS for deployed domains. The origin in `BETTER_AUTH_URL` is already trusted. |
| `BETTER_AUTH_SECRET` | Server-only Better Auth secret of at least 32 characters. Reuse the existing auth secret for session continuity. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google provider settings. Supply both to enable it. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server-only Stripe API key and webhook signing secret. Supply both to enable billing. |
| `IMGBB_API_KEY` | Server-only ImgBB key. Set it in the Express environment or local server `.env` to enable image uploads. |

`GET /` reports HTTP liveness. `GET /readyz` returns `200` when all configured MongoDB connections answer a ping or `503` when a database is unavailable or unconfigured. Supply configuration through your shell or hosting platform and keep secret values out of version control.

## Auth cutover

For a Vercel frontend and a Vercel or Render API, set `TUTORLAGBE_API_URL` on Next.js to the HTTPS API origin. On Express, set `BETTER_AUTH_URL` to the HTTPS **frontend** origin because the browser uses Next.js at `/api/auth/*`. Configure `BETTER_AUTH_SECRET` and the existing authentication database URI on Express, and preserve the database's current `TUTORLAGBE_USER_COLLECTION`. Set `CORS_ALLOWED_ORIGINS` for browser API access separately from the auth allowlist. Keep Google OAuth's authorized redirect URI on the canonical frontend at `/api/auth/callback/google` if Google sign-in is enabled.

After deploying Express, request `GET /api/health/db` on the API origin. It pings the MongoDB client used by Better Auth and returns only `200 {"status":"ok"}` or `503 {"status":"unavailable"}`. Check private server logs for the sanitized diagnostic if it returns 503. A successful ping confirms connectivity, but user collection selection and account read/write permissions still need a sign-in and sign-up smoke test. Allow the API host's outbound network in the Atlas project IP access list and give its database user the required access to `tutorlagbe_db`. Once the API passes the check, deploy Next.js with the Production environment updated, test email sign-up with a test account, then sign in and reload a private dashboard route.

If the catalog works but email sign-in returns `401 INVALID_EMAIL_OR_PASSWORD`, check the API's production startup log for the auth database setting and selected user collection. `BETTER_AUTH_DB_URI` takes precedence for sign-in, while `MONGODB_URI` takes precedence for the catalog. Find the existing user in the selected `tutorlagbe_db` collection (`user` or `users`) and verify their `account` record with provider `credential` references the same user ID. Use the database and collection that already hold your accounts. A `403 INVALID_ORIGIN` calls for checking the frontend origin and auth allowlist.

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
- `POST /api/tuitions` creates a pending listing for the authenticated tutor. Free tutors may have two listings, including listings created before the current posting index. The first eligible Free submission creates the partial unique index `unique_tutor_free_posting_slot` on `tuitions`, so the MongoDB user needs index creation permission.
- `GET /api/tuitions/moderation` and `PATCH /api/tuitions/:id/moderation` require an admin JWT. Send `{ "status": "approved" }` or `{ "status": "rejected" }` for a pending listing.
- `GET /api/tuitions/manage` lists a teacher's own tuitions or all tuitions for an admin. `GET`, `PATCH`, and `DELETE /api/tuitions/manage/:id` use the same ownership rules. Teacher edits return a listing to pending review. Moderation clients send the row's `revision` when present to prevent approving a stale edit.
- The Next.js routes are `/dashboard/tutor/post-tuition`, `/dashboard/admin/tuitions`, and `/tuitions`. They use the same `TUTORLAGBE_API_URL` configured for the auth proxy. Provision admin roles through an authorized administrative process. Public sign-up accepts Student and Tutor.

## Profile management

Use `GET /api/profiles/me` to read your own profile and `PATCH /api/profiles/me` to edit your name, phone, bio, or photo URL. Admins can list profiles at `GET /api/profiles` and read, edit, or delete individual profiles at `/api/profiles/:id`. Deletion removes the account and sessions in a MongoDB transaction. It preserves tuition listings for separate management and protects the last admin account.

## Tuition applications

- Students submit `POST /api/applications` with `tuitionId`, `studentPhone`, `preferredSchedule`, and optional `studentNote`. The tuition must be approved and active. The API derives account and listing fields on the server and creates a unique MongoDB index on student ID and tuition ID on first use.
- Students use `GET /api/applications/mine` to track their applications and `DELETE /api/applications/:id` to cancel a pending application. A cancelled application can be submitted again.
- Teachers use `GET /api/applications/received` to see applications to their tuitions and `PATCH /api/applications/:id/status` to accept or reject a pending application. Application contact information is available only through the protected dashboards.

Students can use `GET /api/tuitions/saved?page=1` to list their bookmarks. `GET`, `PUT`, and `DELETE /api/tuitions/saved/:id` check, save, and remove a bookmark. All four operations use the authenticated student account. Only approved, active tuitions can be saved or appear in the list.

Students with an accepted application can submit one review through `POST /api/applications/:id/review` with an integer `rating` from 1 to 5 and written `feedback` up to 1,000 characters. `GET /api/tuitions/:id/reviews?page=1` lists reviews for approved, active tuitions without exposing the reviewer's account or application details.

## Stripe Pro Checkout in test mode

Students pay $10 USD and tutors pay $15 USD once. Express derives the account, role, and price from the authenticated session. `POST /api/payments/create-checkout-session` returns a Stripe-hosted Checkout URL. `GET /api/payments/history` shows the signed-in account's attempts. The existing admin transactions view continues to show paid transactions.

1. Copy the settings you need from each repository's `.env.example` into its local environment. Set the Express `STRIPE_SECRET_KEY` to the secret API key from your Stripe sandbox. Use an isolated test database if you want to keep test upgrades separate from other accounts.
2. Sign in to Stripe CLI and run the following command. Use your Express port if it differs from 8000. Save the listener's signing secret as `STRIPE_WEBHOOK_SECRET` in the Express environment and keep the listener running.

   ```sh
   stripe login
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed --forward-to http://127.0.0.1:8000/api/payments/webhook
   ```

3. From the workspace root, start both apps with `node scripts/dev.mjs`. The launcher sets `TUTORLAGBE_API_URL` for Next.js. When starting the apps separately, set it to the Express origin, for example `http://127.0.0.1:8000`, and set `BETTER_AUTH_URL` to the browser-facing Next.js origin. Express reads its repository's `.env` regardless of the startup directory. Pro uses Stripe when Express reports `stripeTestCheckout: true` at `GET /api/payments/config`.
4. Sign in as a Free student or tutor and select Pro. Confirm the amount on Stripe and pay with test card `4242 4242 4242 4242`, a future expiry, and any three-digit CVC. Verify the result page, account plan, and paid entry under `/payment/history`. Repeat with the other role.
5. Use Stripe's declined test card `4000 0000 0000 0002` to verify failed payment handling. Use Checkout's back link to verify the cancel page. An abandoned Checkout stays reusable until it expires. To test expiry, use `stripe checkout sessions expire cs_test_...` on an open test session from this app. Generic CLI fixtures lack this app's account metadata and are ignored for fulfillment.

The webhook verifies signatures against the original request body, ignores live events, and retrieves the Checkout Session from Stripe. It verifies the account, role, amount, currency, payment mode, and payment status. One-time records are unique by Checkout Session ID. Payment confirmation and the account upgrade use a MongoDB transaction when supported. On a standalone server, a repeat delivery can finish an account update after the payment record was saved.

For a new database using the assignment's `users` collection, set `TUTORLAGBE_USER_COLLECTION=users` for Express and Next.js before registering accounts. Existing installations default to Better Auth's `user` collection. To rename an existing collection, stop all app instances, back up the database, and use MongoDB's collection rename with destination replacement disabled. Set both apps to use `users` before restarting. Keeping the same account IDs preserves existing references.

Existing Stripe test subscriptions can still be managed through the billing portal. If you have those subscriptions, also forward `invoice.paid` and the `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `customer.subscription.paused` events. New upgrades use one-time Checkout.

## Local mock payments

In PowerShell at the workspace root, run:

```powershell
$env:ENABLE_MOCK_PAYMENTS = 'true'
node scripts/dev.mjs
```

Sign in as a student or tutor, then choose Plus ($10) or Pro ($10 for students and $15 for tutors). The mock updates the account in the configured database and creates a paid record with provider `mock`. Use a development database for these upgrades. When Stripe test checkout is also configured, set `TUTORLAGBE_CHECKOUT_MODE=mock` in the Next.js shell to use mock Pro checkout. Express returns 404 for mock checkout in production, even when the flag is set.
