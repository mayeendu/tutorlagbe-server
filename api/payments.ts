import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { verifyAdmin, verifyToken, type AuthIdentity } from './access.ts';
import type { TutorAuth } from './auth.ts';
import { handleCheckoutEvent, oneTimeCheckoutForm, pendingCheckout, proPrice } from './one-time-checkout.ts';
import type { PaymentStore } from './payment-store.ts';
import { stripeEventSchema, validStripeSignature, type StripeGateway } from './stripe.ts';

const metadata = z.object({ integration: z.literal('tutorlagbe-pro'), userId: z.string().regex(/^[\w-]{1,128}$/), role: z.enum(['student', 'tutor']) });
const ended = new Set(['canceled', 'incomplete_expired']);
const revoked = new Set([...ended, 'unpaid', 'paused']);
const access = new Set(['active', 'past_due']);

export type BillingOptions = { origin: string; webhookSecret: string; stripe: StripeGateway; store: PaymentStore };

function stripeUrl(value: string | null, hostname: string) {
    const url = value && URL.parse(value);
    if (!url || url.origin !== `https://${hostname}` || url.username || url.password) throw new Error('Invalid Stripe redirect.');
    return url.href;
}

export function paymentRoutes(auth: TutorAuth, { origin, webhookSecret, stripe, store }: BillingOptions) {
    const router = express.Router();
    const authenticate = verifyToken(auth);
    router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });

    async function recordInvoice(id: string, eventAt: number, current?: Awaited<ReturnType<StripeGateway['subscription']>>) {
        const invoice = await stripe.invoice(id);
        const subscriptionId = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
        if (invoice.status !== 'paid' || !subscriptionId || !invoice.payment_intent?.startsWith('pi_')) return;
        const subscription = current?.id === subscriptionId ? current : await stripe.subscription(subscriptionId);
        const claims = metadata.safeParse(subscription.metadata);
        if (!claims.success || invoice.currency !== 'usd' || invoice.amount_paid !== proPrice[claims.data.role]) return;

        const checkout = await stripe.checkoutForSubscription(subscription.id);
        if (!checkout) throw new Error('Checkout is not yet available.');
        const checkoutClaims = metadata.safeParse(checkout.metadata);
        if (!checkoutClaims.success || checkoutClaims.data.userId !== claims.data.userId ||
            checkoutClaims.data.role !== claims.data.role || checkout.subscription !== subscription.id) return;

        await store.record({
            _id: invoice.id, userId: claims.data.userId, userRole: claims.data.role,
            userName: invoice.customer_name ?? 'Deleted account', userEmail: invoice.customer_email ?? '',
            amount: invoice.amount_paid, currency: 'usd', planName: 'Pro',
            paymentStatus: 'paid', stripeSessionId: checkout.id, stripeSubscriptionId: subscription.id,
            transactionId: invoice.payment_intent, paidAt: new Date((invoice.status_transitions?.paid_at ?? eventAt) * 1000),
        }, access.has(subscription.status), eventAt);
    }

    router.post('/webhook', express.raw({ type: 'application/json', limit: '256kb', inflate: false }), async (request, response) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || !validStripeSignature(body, request.get('Stripe-Signature') ?? '', webhookSecret)) {
            response.status(400).json({ error: 'Invalid Stripe signature.' });
            return;
        }
        let decoded: unknown;
        try { decoded = JSON.parse(body.toString('utf8')); } catch {
            response.status(400).json({ error: 'Invalid Stripe event.' });
            return;
        }
        const parsed = stripeEventSchema.safeParse(decoded);
        if (!parsed.success) {
            response.status(400).json({ error: 'Invalid Stripe event.' });
            return;
        }

        const event = parsed.data;
        if (event.livemode) {
            response.json({ received: true });
            return;
        }
        const id = event.data.object.id;
        if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
            'checkout.session.expired', 'payment_intent.payment_failed'].includes(event.type)) {
            await handleCheckoutEvent(event, { origin, webhookSecret, stripe, store });
        }
        if (event.type === 'invoice.paid' && /^in_\w+$/.test(id)) {
            await recordInvoice(id, event.created);
        } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused'].includes(event.type) && /^sub_\w+$/.test(id)) {
            const subscription = await stripe.subscription(id);
            const claims = metadata.safeParse(subscription.metadata);
            if (claims.success && revoked.has(subscription.status)) {
                await store.revoke(claims.data.userId, subscription.id, event.created, ended.has(subscription.status));
            } else if (claims.success && subscription.status === 'active' && subscription.latest_invoice) {
                await recordInvoice(subscription.latest_invoice, event.created, subscription);
            }
        }
        response.json({ received: true });
    });

    router.post(['/create-checkout-session', '/checkout'], authenticate, async (_request, response) => {
        const identity: AuthIdentity = response.locals.identity;
        if (identity.role === 'admin') {
            response.status(403).json({ error: 'Pro is available to students and teachers.' });
            return;
        }
        const user = await store.user(identity.id);
        if (!user || user.plan === 'pro') {
            response.status(409).json({ error: 'Your account is already on Pro or is unavailable.' });
            return;
        }

        let attempt = user.stripeCheckout;
        if (attempt?.sessionId) {
            const prior = await stripe.checkout(attempt.sessionId);
            if (prior.status === 'open' && attempt.kind === 'one-time' && attempt.role === identity.role) {
                pendingCheckout(prior, identity.id, user.name, attempt);
                response.json({ url: stripeUrl(prior.url, 'checkout.stripe.com') });
                return;
            }
            const failed = prior.status === 'complete' && prior.payment_status === 'unpaid' && attempt.kind === 'one-time' &&
                (await store.checkoutPayment(prior.id, identity.id))?.status === 'failed';
            const legacyEnded = prior.status === 'complete' && prior.subscription &&
                ended.has((await stripe.subscription(prior.subscription)).status);
            if (prior.status !== 'expired' && !failed && !legacyEnded) {
                response.status(409).json({ error: 'There is already a checkout or subscription for this account.' });
                return;
            }
        }
        if (!attempt || attempt.sessionId) {
            const next = { key: randomUUID(), email: identity.email, role: identity.role, kind: 'one-time' as const };
            if (!await store.reserve(identity.id, attempt?.key, next)) {
                response.status(409).json({ error: 'Checkout is already being prepared. Try again shortly.' });
                return;
            }
            attempt = next;
        }
        if (attempt.role !== identity.role || attempt.kind !== 'one-time') {
            response.status(409).json({ error: 'A previous checkout needs to be resolved before you can continue.' });
            return;
        }

        const checkout = await stripe.createCheckout(oneTimeCheckoutForm(origin, identity.id, attempt), `tutorlagbe-pro-once-${attempt.key}`);
        const url = stripeUrl(checkout.url, 'checkout.stripe.com');
        await store.savePending(pendingCheckout(checkout, identity.id, user.name, attempt));
        await store.saveSession(identity.id, attempt.key, checkout.id);
        response.json({ url });
    });

    router.get('/status/:id', authenticate, async (request, response) => {
        const id = request.params.id;
        if (typeof id !== 'string' || !/^cs_\w{1,200}$/.test(id)) {
            response.status(400).json({ error: 'Invalid checkout session.' });
            return;
        }
        const identity: AuthIdentity = response.locals.identity;
        const user = await store.user(identity.id);
        const payment = await store.checkoutPayment(id, identity.id);
        if (payment) {
            response.json({ status: payment.status === 'paid'
                ? user?.plan === 'pro' && user.proPaymentSessionId === id ? 'active' : 'pending'
                : payment.status });
            return;
        }
        if (user?.stripeCheckout?.sessionId !== id) {
            response.status(404).json({ error: 'Checkout session not found.' });
            return;
        }
        const checkout = await stripe.checkout(id);
        response.json({ status: checkout.status === 'expired' ? 'expired' :
            checkout.subscription && user.plan === 'pro' && user.stripeSubscriptionId === checkout.subscription ? 'active' : 'pending' });
    });

    router.post('/portal', authenticate, async (_request, response) => {
        const user = await store.user(response.locals.identity.id);
        if (!user?.stripeSubscriptionId) {
            response.status(404).json({ error: 'No Stripe subscription was found.' });
            return;
        }
        const subscription = await stripe.subscription(user.stripeSubscriptionId);
        const claims = metadata.safeParse(subscription.metadata);
        if (!claims.success || claims.data.userId !== response.locals.identity.id) {
            response.status(404).json({ error: 'No Stripe subscription was found.' });
            return;
        }
        const billing = await stripe.portal(subscription.customer, `${origin}/pricing`);
        response.json({ url: stripeUrl(billing.url, 'billing.stripe.com') });
    });

    router.get('/history', authenticate, async (request, response) => {
        const page = z.coerce.number().int().min(1).max(1000).default(1).safeParse(request.query.page);
        if (!page.success) {
            response.status(400).json({ error: 'Invalid payment page.' });
            return;
        }
        const id: string = response.locals.identity.id;
        const [rows, user] = await Promise.all([store.history(id, (page.data - 1) * 24, 25), store.user(id)]);
        response.json({ items: rows.slice(0, 24), hasMore: rows.length > 24 && page.data < 1000,
            canManageSubscription: Boolean(user?.stripeSubscriptionId) });
    });

    router.get('/transactions', authenticate, verifyAdmin, async (request, response) => {
        const page = z.coerce.number().int().min(1).max(1000).default(1).safeParse(request.query.page);
        if (!page.success) {
            response.status(400).json({ error: 'Invalid transaction page.' });
            return;
        }
        const rows = await store.latest((page.data - 1) * 24, 25);
        response.json({ items: rows.slice(0, 24), hasMore: rows.length > 24 && page.data < 1000 });
    });

    const onError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if ([400, 413, 415].includes(error.status)) response.status(error.status).json({ error: 'Invalid Stripe request.' });
        else response.status(503).json({ error: 'Billing is temporarily unavailable.' });
    };
    router.use(onError);
    return router;
}
