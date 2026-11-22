# TutorLagbe API

Run `npm run dev` from this repository. For production, run `npm run build` followed by `npm start`. Run `npm test` for the local HTTP integration tests and `npm run typecheck` for TypeScript checks.

Run `npm run seed:tuitions` against the configured database to populate an underfilled catalog with 12 approved listings linked to six sample teacher profiles. The command uses stable IDs, preserves existing records, and skips catalogs that already have at least 12 active, approved listings linked to tutors across at least eight subjects. Use `npm run seed:tuitions -- --check` to check the threshold without writing records. Sample profiles have no login credentials.

When both repositories are in the TutorLagbe workspace, `node scripts/dev.mjs` from the workspace root starts them together for local development. It reuses existing auth settings and configures the Next.js proxy in the child process environment. The launcher waits for MongoDB readiness and leaves local environment files untouched.

For separate `npm run dev` processes in this workspace, Next.js defaults to Express on `http://127.0.0.1:8000` when `TUTORLAGBE_API_URL` is unset or blank. Express uses the sibling client's local Better Auth settings when Express has neither database URI configured. Set `TUTORLAGBE_API_URL` explicitly if Express uses a different port. Production uses the settings of each deployed service.

If the tuition page reports that listings are unavailable, check `GET /readyz` and `GET /api/tuitions?page=1` directly on Express. Readiness confirms the configured MongoDB connection. The listings route should return JSON with an `items` array. In the deployed Next.js settings, use the stable Express HTTPS origin as `TUTORLAGBE_API_URL` and redeploy after changing it. Set Express `BETTER_AUTH_URL` to the Next.js origin and keep the MongoDB URI and user collection aligned with your existing data. Incomplete Stripe configuration disables Checkout while the tuition API remains available.

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

On Vercel, set both Stripe variables in the **Production** environment of the Express project (`tutor-lagbe` in this workspace). Use the test API key and the signing secret for the deployed test webhook endpoint at `/api/payments/webhook`. Redeploy Express after changing these settings. Its startup log reports only billing presence and readiness flags. Check `GET /api/payments/config` on Express and through the frontend. Both should report `stripeTestCheckout: true`. This confirms route initialization. An authenticated checkout test verifies the key against Stripe.

Payment history and admin transactions use MongoDB independently of the Stripe gateway. When checkout is disabled, authenticated users can still read their records and admins can still read transactions. Stripe Checkout supports one-time Plus and Pro purchases.
| `IMGBB_API_KEY` | Server-only ImgBB key. Set it in the Express environment or local server `.env` to enable image uploads. |

`GET /` reports HTTP liveness. `GET /readyz` returns `200` when all configured MongoDB connections answer a ping or `503` when a database is unavailable or unconfigured. Supply configuration through your shell or hosting platform and keep secret values out of version control.

## Auth cutover

For a Vercel frontend and a Vercel or Render API, set `TUTORLAGBE_API_URL` on Next.js to the HTTPS API origin. On Express, set `BETTER_AUTH_URL` to the HTTPS **frontend** origin because the browser uses Next.js at `/api/auth/*`. Configure `BETTER_AUTH_SECRET` and the existing authentication database URI on Express, and preserve the database's current `TUTORLAGBE_USER_COLLECTION`. Set `CORS_ALLOWED_ORIGINS` for browser API access separately from the auth allowlist. Keep Google OAuth's authorized redirect URI on the canonical frontend at `/api/auth/callback/google` if Google sign-in is enabled.

Set `BETTER_AUTH_URL` to the exact public frontend origin so OAuth callbacks and session URLs use the correct host. Use HTTPS on deployed sites. Set `TUTORLAGBE_API_URL` on Next.js to the separate Express origin. Configure frontend aliases in `BETTER_AUTH_TRUSTED_ORIGINS` and list direct browser API origins in `CORS_ALLOWED_ORIGINS`.

After deploying Express, request `GET /api/health/db` on the API origin. It pings the MongoDB client used by Better Auth and returns only `200 {"status":"ok"}` or `503 {"status":"unavailable"}`. Check private server logs for the sanitized diagnostic if it returns 503. A successful ping confirms connectivity, but user collection selection and account read/write permissions still need a sign-in and sign-up smoke test. Allow the API host's outbound network in the Atlas project IP access list and give its database user the required access to `tutorlagbe_db`. Once the API passes the check, deploy Next.js with the Production environment updated, test email sign-up with a test account, then sign in and reload a private dashboard route.

If the catalog works but email sign-in returns `401 INVALID_EMAIL_OR_PASSWORD`, check the API's production startup log for the auth database setting and selected user collection. `BETTER_AUTH_DB_URI` takes precedence for sign-in, while `MONGODB_URI` takes precedence for the catalog. Find the existing user in the selected `tutorlagbe_db` collection (`user` or `users`) and verify their `account` record with provider `credential` references the same user ID. Use the database and collection that already hold your accounts. A `403 INVALID_ORIGIN` calls for checking the frontend origin and auth allowlist.

1. Configure the Express service with the same database, public origin, and secret used by the existing Next.js auth service. Verify `/readyz` before switching traffic.
2. Set the server-only `TUTORLAGBE_API_URL` on the Next.js service to the Express origin, for example `http://localhost:8000` locally. On Vercel, use the API project's HTTPS origin and confirm that its `/health` and `/api/health/db` return JSON. Browser requests stay on the Next.js origin, where `/api/auth/*` forwards cookies and browser origin headers to Express. A missing API URL returns `503 AUTH_UNAVAILABLE` in production. The legacy handler is available for local development.
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

## Stripe Checkout in test mode

On Vercel, publish the updated Express project and confirm `GET /api/payments/config` reports `stripeTestCheckout: true`, `stripeCheckoutPlans: ["plus", "pro"]`, and `mockCheckout: false`. The Next.js payment page uses this response to enable the selected plan. An older Express release can report Stripe readiness while only supporting Pro.

Plus costs $10 USD for either role. Pro costs $10 USD for students and $15 USD for tutors. `POST /api/payments/create-checkout-session` accepts `{ "plan": "plus" }` or `{ "plan": "pro" }` and returns a Stripe-hosted Checkout URL. An empty request defaults to Pro for existing callers. Express derives the account, role and price server-side. Plus accounts can purchase Pro at the listed price. `GET /api/payments/history` shows the signed-in account's attempts, and the admin transactions view shows paid transactions.

For a hosted test deployment, register `https://<express-host>/api/payments/webhook` in the Stripe sandbox. Select `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, and `payment_intent.payment_failed`. Use the signing secret for that endpoint on the Express service. Set `BETTER_AUTH_URL` to the public Next.js origin and `TUTORLAGBE_API_URL` on Next.js to the Express origin. Use an isolated Atlas database for hosted sandbox tests because test payments update real account documents in the configured database. Set `TUTORLAGBE_USER_COLLECTION=users` for a fresh assignment database and retain the existing auth collection setting on established deployments.

1. Copy the settings you need from each repository's `.env.example` into its local environment. Set the Express `STRIPE_SECRET_KEY` to the secret API key from your Stripe sandbox. Use an isolated test database if you want to keep test upgrades separate from other accounts.
2. Sign in to Stripe CLI and run the following command. Use your Express port if it differs from 8000. Save the listener's signing secret as `STRIPE_WEBHOOK_SECRET` in the Express environment and keep the listener running.

   ```sh
   stripe login
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed --forward-to http://127.0.0.1:8000/api/payments/webhook
   ```

3. From the workspace root, start both apps with `node scripts/dev.mjs`. The launcher sets `TUTORLAGBE_API_URL` for Next.js. When starting the apps separately, set it to the Express origin, for example `http://127.0.0.1:8000`, and set `BETTER_AUTH_URL` to the browser-facing Next.js origin. Express reads its repository's `.env` regardless of the startup directory. Check that `GET /api/payments/config` reports `stripeTestCheckout: true` and `mockCheckout: false`.
4. Sign in as a Free student or tutor and select Plus. Pay with test card `4242 4242 4242 4242`, any future expiry, any three-digit CVC and a valid ZIP if prompted. Verify the success page, the Plus account plan and one paid entry under `/payment/history`. Then purchase Pro, check the role price and repeat verification. Resend the Plus completion event and confirm the account stays on Pro and history still has one paid entry per session.
5. Use Stripe's declined test card `4000 0000 0000 0002` to test payment failure. Use Checkout's back link to reach the cancel page and resume the same plan. Selecting a different plan expires the open session before creating its replacement. Generic Stripe CLI fixtures lack this app's account metadata and are ignored for fulfillment.

The webhook verifies signatures against the original request body, ignores live events, and retrieves the Checkout Session from Stripe. It verifies the account, role, amount, currency, payment mode, and payment status. One-time records are unique by Checkout Session ID. Payment confirmation and the account upgrade use a MongoDB transaction when supported. On a standalone server, a repeat delivery can finish an account update after the payment record was saved.

For a new database using the assignment's `users` collection, set `TUTORLAGBE_USER_COLLECTION=users` for Express and Next.js before registering accounts. Existing installations default to Better Auth's `user` collection. To rename an existing collection, stop all app instances, back up the database, and use MongoDB's collection rename with destination replacement disabled. Set both apps to use `users` before restarting. Keeping the same account IDs preserves existing references.

Existing Stripe test subscriptions can still be managed through the billing portal. If you have those subscriptions, also forward `invoice.paid` and the `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `customer.subscription.paused` events. New upgrades use one-time Checkout.

## Local mock payments

In PowerShell at the workspace root, run:

```powershell
$env:ENABLE_MOCK_PAYMENTS = 'true'
node scripts/dev.mjs
```

Sign in as a student or tutor, then choose Plus ($10 USD) or Pro ($10 USD for students and $15 USD for tutors). Checkout sessions expire after 30 minutes. Successful payments create a 30-day demo entitlement in the mock payment record. The user's Stripe and account plan fields keep their existing values. Payment history displays the demo plan and mock transactions when demo mode is enabled. Leave `ENABLE_MOCK_PAYMENTS` unset when you want to use Stripe Test Mode locally.

Mock checkout runs only in local development with Stripe disabled. Production blocks mock checkout creation and fulfillment even when legacy demo flags are set.
