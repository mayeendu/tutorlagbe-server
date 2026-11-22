import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { verifyToken, type AuthIdentity } from './access.ts';
import type { TutorAuth } from './auth.ts';
import { checkoutPrice } from './one-time-checkout.ts';
import type { PaymentStore } from './payment-store.ts';

const purchase = z.object({ plan: z.enum(['plus', 'pro']) }).strict();
const outcome = z.object({ action: z.enum(['pay', 'fail', 'cancel']) }).strict();
const outcomes = { pay: 'paid', fail: 'failed', cancel: 'cancelled' } as const;
const sessionId = /^mock_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

export function authorizedDemoDeployment() {
    const origin = process.env.DEMO_FRONTEND_ORIGIN?.trim();
    const url = URL.parse(origin ?? '');
    return process.env.ENABLE_DEMO_DEPLOYMENT === 'true' && url?.protocol === 'https:' &&
        url.origin === origin && !url.hostname.includes('*') &&
        origin !== 'https://tutorlagbe-client.vercel.app' && origin !== 'https://tutor-lagbe-kappa.vercel.app' &&
        process.env.BETTER_AUTH_URL?.trim() === origin;
}

export function mockPaymentsEnabled() {
    return process.env.ENABLE_MOCK_PAYMENTS === 'true' &&
        process.env.NODE_ENV === 'development' &&
        (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'development');
}

export type MockPaymentStore = Pick<PaymentStore, 'createMockSession' | 'mockSession' | 'settleMockSession' | 'mockEntitlement'>;

function sessionView(payment: NonNullable<Awaited<ReturnType<MockPaymentStore['mockSession']>>>) {
    return { id: payment._id, plan: payment.plan, amount: payment.amount, currency: payment.currency,
        status: payment.status, expiresAt: payment.checkoutExpiresAt, entitlementExpiresAt: payment.entitlementExpiresAt };
}

export function mockPaymentRoutes(auth: TutorAuth, store: MockPaymentStore) {
    const router = express.Router();
    const parseJson = express.json({ limit: '2kb' });
    router.use(verifyToken(auth), (_request, response, next) => {
        if (response.locals.identity.role === 'admin') {
            response.status(403).json({ error: 'Mock upgrades are available to students and tutors.' });
            return;
        }
        next();
    });
    router.post('/', parseJson, async (request, response) => {
        const identity = response.locals.identity as AuthIdentity & { role: 'student' | 'tutor' };
        const parsed = purchase.safeParse(request.body);
        if (!parsed.success) {
            response.status(400).json({ error: 'Choose Plus or Pro.' });
            return;
        }

        const { plan } = parsed.data;
        const amount = checkoutPrice(plan, identity.role);
        const payment = await store.createMockSession(identity.id, identity.role, plan, amount);
        if (!payment) {
            response.status(409).json({ error: 'This plan is unavailable for your account.' });
            return;
        }
        response.status(201).json(sessionView(payment));
    });
    router.get('/subscription', async (_request, response) => {
        const { id, role } = response.locals.identity;
        response.json(await store.mockEntitlement(id, role) ?? { plan: 'free', expiresAt: null });
    });
    router.get('/:id', async (request, response) => {
        const { id } = request.params;
        const identity = response.locals.identity;
        const payment = sessionId.test(id) ? await store.mockSession(id, identity.id, identity.role) : null;
        if (!payment) { response.status(404).json({ error: 'Demo checkout not found.' }); return; }
        response.json(sessionView(payment));
    });
    router.post('/:id', parseJson, async (request, response) => {
        const { id } = request.params;
        const parsed = outcome.safeParse(request.body);
        if (!parsed.success) { response.status(400).json({ error: 'Choose a demo payment action.' }); return; }
        const identity = response.locals.identity;
        const status = outcomes[parsed.data.action];
        const payment = sessionId.test(id)
            ? await store.settleMockSession(id, identity.id, identity.role, status) : null;
        if (!payment) { response.status(404).json({ error: 'Demo checkout not found.' }); return; }
        if (payment.status !== status) {
            response.status(409).json({ error: 'This demo checkout has already ended.' });
            return;
        }
        response.json(sessionView(payment));
    });
    const onError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if ([400, 413, 415].includes(error.status)) {
            response.status(error.status).json({ error: 'Invalid mock checkout request.' });
        } else {
            response.status(503).json({ error: 'Could not complete mock checkout. Please retry.' });
        }
    };
    router.use(onError);
    return router;
}
