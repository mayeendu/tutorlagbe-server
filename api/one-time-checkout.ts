import { z } from 'zod';

import type { CheckoutAttempt, CheckoutPayment, PaidRole } from './payment-store.ts';
import type { BillingOptions } from './payments.ts';
import type { StripeGateway, stripeEventSchema } from './stripe.ts';

export const proPrice: Record<PaidRole, number> = { student: 1000, tutor: 1500 };
const checkoutClaims = z.object({
    integration: z.literal('tutorlagbe-pro-once'),
    userId: z.string().regex(/^[\w-]{1,128}$/),
    role: z.enum(['student', 'tutor']),
    attempt: z.uuid(),
});
type Session = Awaited<ReturnType<StripeGateway['checkout']>>;
type Event = z.infer<typeof stripeEventSchema>;

export function oneTimeCheckoutForm(origin: string, userId: string, attempt: CheckoutAttempt) {
    const form = new URLSearchParams({
        mode: 'payment', customer_email: attempt.email, client_reference_id: userId,
        success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/payment/cancel`,
        'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(proPrice[attempt.role]),
        'line_items[0][price_data][product_data][name]': `TutorLagbe Pro · ${attempt.role === 'student' ? 'Student' : 'Tutor'}`,
    });
    for (const [key, value] of Object.entries({ integration: 'tutorlagbe-pro-once', userId, role: attempt.role, attempt: attempt.key })) {
        form.set(`metadata[${key}]`, value);
        form.set(`payment_intent_data[metadata][${key}]`, value);
    }
    return form;
}

function verifiedClaims(checkout: Session) {
    const claims = checkoutClaims.safeParse(checkout.metadata);
    if (!claims.success || checkout.livemode !== false || !checkout.id.startsWith('cs_test_') ||
        checkout.mode !== 'payment' || checkout.currency !== 'usd' ||
        checkout.client_reference_id !== claims.data.userId || checkout.amount_total !== proPrice[claims.data.role]) return;
    return claims.data;
}

export function pendingCheckout(checkout: Session, userId: string, userName: string, attempt: CheckoutAttempt): CheckoutPayment {
    const claims = verifiedClaims(checkout);
    if (!claims || claims.userId !== userId || claims.role !== attempt.role || claims.attempt !== attempt.key) {
        throw new Error('Unexpected Stripe Checkout data.');
    }
    const now = new Date();
    return {
        _id: checkout.id, kind: 'one-time', status: 'pending', stripeSessionId: checkout.id,
        userId, userName, userEmail: attempt.email, userRole: attempt.role, amount: proPrice[attempt.role],
        currency: 'usd', planName: 'Pro', createdAt: now, updatedAt: now,
    };
}

export async function handleCheckoutEvent(event: Event, { stripe, store }: BillingOptions) {
    const { id, metadata } = event.data.object;
    let checkout: Session;
    if (event.type === 'payment_intent.payment_failed') {
        const claims = checkoutClaims.safeParse(metadata);
        if (!claims.success || !/^pi_\w+$/.test(id)) return;
        const user = await store.user(claims.data.userId);
        const attempt = user?.stripeCheckout;
        if (attempt?.key !== claims.data.attempt || !attempt.sessionId) return;
        checkout = await stripe.checkout(attempt.sessionId);
        if (checkout.payment_intent !== id) return;
    } else {
        if (!/^cs_test_\w{1,200}$/.test(id)) return;
        checkout = await stripe.checkout(id);
        if (checkout.id !== id) return;
    }

    const claims = verifiedClaims(checkout);
    if (!claims) return;
    const payment = await store.checkoutPayment(checkout.id, claims.userId);
    if (!payment || payment.userRole !== claims.role || payment.amount !== checkout.amount_total || payment.currency !== checkout.currency) return;
    const user = await store.user(claims.userId);
    if (!user || user.role !== claims.role) return;

    let status: CheckoutPayment['status'];
    if (checkout.status === 'complete' && checkout.payment_status === 'paid' && /^pi_\w+$/.test(checkout.payment_intent ?? '')) {
        status = 'paid';
    } else if (event.type === 'checkout.session.expired' && checkout.status === 'expired') {
        status = 'expired';
    } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'payment_intent.payment_failed') {
        if (checkout.payment_status !== 'unpaid') return;
        status = 'failed';
    } else {
        return;
    }
    const eventDate = new Date(event.created * 1000);
    await store.settleCheckout({
        ...payment, status, stripeEventId: event.id, updatedAt: eventDate,
        ...(checkout.payment_intent ? { transactionId: checkout.payment_intent } : {}),
        ...(checkout.customer ? { stripeCustomerId: checkout.customer } : {}),
        ...(status === 'paid' ? { paidAt: eventDate } : {}),
    }, event.created);
}
