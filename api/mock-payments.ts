import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { verifyToken, type AuthIdentity } from './access.ts';
import type { TutorAuth } from './auth.ts';
import { proPrice } from './one-time-checkout.ts';
import type { PaymentStore } from './payment-store.ts';

const purchase = z.object({ plan: z.enum(['plus', 'pro']) }).strict();

export function mockPaymentsEnabled() {
    return process.env.ENABLE_MOCK_PAYMENTS === 'true' &&
        process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
}

export function mockPaymentRoutes(auth: TutorAuth, store: Pick<PaymentStore, 'mockCheckout'>) {
    const router = express.Router();
    router.post('/', verifyToken(auth), express.json({ limit: '2kb' }), async (request, response) => {
        const identity: AuthIdentity = response.locals.identity;
        if (identity.role === 'admin') {
            response.status(403).json({ error: 'Mock upgrades are available to students and tutors.' });
            return;
        }
        const parsed = purchase.safeParse(request.body);
        if (!parsed.success) {
            response.status(400).json({ error: 'Choose Plus or Pro.' });
            return;
        }

        const { plan } = parsed.data;
        const amount = plan === 'plus' ? 1000 : proPrice[identity.role];
        const payment = await store.mockCheckout(identity.id, identity.role, plan, amount);
        if (!payment) {
            response.status(409).json({ error: 'This plan is unavailable for your account.' });
            return;
        }
        response.json(payment);
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
