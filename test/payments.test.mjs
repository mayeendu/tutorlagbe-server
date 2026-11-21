import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';

import { memoryAdapter } from 'better-auth/adapters/memory';
import { MongoServerError } from 'mongodb';

import { createApi } from '../api/app.ts';
import { createAuth } from '../api/auth.ts';
import { paymentStore } from '../api/payment-store.ts';
import { validStripeSignature } from '../api/stripe.ts';

const origin = 'https://tutorlagbe.example';
const webhookSecret = 'isolated-signing-fixture-only';

function sign(body, timestamp = Math.floor(Date.now() / 1000)) {
    const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(body).digest('hex');
    return `t=${timestamp},v1=${digest}`;
}

test('Stripe signature requires the original payload and a recent timestamp', () => {
    const body = Buffer.from('{"valid":true}');
    const time = 1_700_000_000;
    const signature = sign(body, time);
    assert.equal(validStripeSignature(body, signature, webhookSecret, time * 1000), true);
    assert.equal(validStripeSignature(Buffer.from('{"valid":false}'), signature, webhookSecret, time * 1000), false);
    assert.equal(validStripeSignature(body, signature, webhookSecret, (time + 301) * 1000), false);
    assert.equal(validStripeSignature(body, signature + ',t=' + time, webhookSecret, time * 1000), false);
});

test('standalone MongoDB fulfillment can resume after the payment write', async () => {
    const now = new Date();
    const payment = {
        _id: 'cs_test_retry', kind: 'one-time', status: 'pending', stripeSessionId: 'cs_test_retry',
        userId: 'buyer', userRole: 'student', amount: 1000, currency: 'usd', createdAt: now, updatedAt: now,
    };
    const user = { _id: 'buyer', role: 'student', plan: 'free' };
    let accountWrites = 0;
    const collections = {
        users: {
            findOne: async () => user,
            async updateOne(_filter, update) {
                if (++accountWrites === 1) throw new Error('Simulated interruption');
                Object.assign(user, update.$set);
            },
        },
        payments: {
            async updateOne(_filter, update) {
                if (payment.status !== 'paid') Object.assign(payment, update.$set);
            },
            findOne: async () => payment.status === 'paid' ? payment : null,
        },
    };
    const db = { collection: name => collections[name] };
    const client = { withSession: async () => {
        throw new MongoServerError({ code: 20, message: 'Transaction numbers are only allowed on a replica set member or mongos' });
    } };
    const store = paymentStore(client, db, 'users');
    const confirmed = { ...payment, status: 'paid', paidAt: now, stripeEventId: 'evt_retry' };
    await assert.rejects(() => store.settleCheckout(confirmed, 100), /Simulated interruption/);
    assert.equal(payment.status, 'paid');
    assert.equal(user.plan, 'free');
    await store.settleCheckout(confirmed, 100);
    assert.equal(user.plan, 'pro');
    assert.equal(user.proPaymentSessionId, payment.stripeSessionId);
    assert.equal(payment.paidAt, now);
});

test('Stripe test Checkout protects role prices, verifies payment outcomes and preserves legacy billing', async (context) => {
    const auth = createAuth({ database: memoryAdapter({ users: [], session: [], account: [], verification: [], jwks: [] }),
        userCollection: 'users', baseURL: origin, secret: 'isolated-billing-auth-test-secret-631982' });
    const { adapter } = await auth.$context;
    const users = new Map(), checkouts = new Map(), subscriptions = new Map(), invoices = new Map(), payments = new Map();
    const requests = [];
    const store = {
        user: async id => users.get(id),
        async reserve(id, previous, attempt) {
            const user = users.get(id);
            if (user.plan !== 'free' || user.stripeCheckout?.key !== previous) return false;
            user.stripeCheckout = attempt;
            return true;
        },
        async saveSession(id, attempt, sessionId) {
            const user = users.get(id);
            if (user.stripeCheckout?.key === attempt) user.stripeCheckout.sessionId = sessionId;
        },
        async record(payment, entitled) {
            if (!payments.has(payment._id)) payments.set(payment._id, payment);
            const user = users.get(payment.userId);
            if (entitled) {
                user.stripeSubscriptionId = payment.stripeSubscriptionId;
                user.plan = 'pro';
                await adapter.update({ model: 'user', where: [{ field: 'id', value: payment.userId }], update: { plan: 'pro' } });
            }
        },
        async revoke(userId, subscriptionId) {
            const user = users.get(userId);
            if (user.stripeSubscriptionId === subscriptionId) user.plan = 'free';
        },
        async savePending(payment) {
            if (!payments.has(payment._id)) payments.set(payment._id, payment);
        },
        checkoutPayment: async (id, userId) => {
            const payment = payments.get(id);
            return payment?.userId === userId && payment.kind === 'one-time' ? payment : null;
        },
        async settleCheckout(payment) {
            if (payments.get(payment._id).status !== 'paid') payments.set(payment._id, payment);
            if (payment.status !== 'paid') return;
            const user = users.get(payment.userId);
            user.proPaymentSessionId = payment.stripeSessionId;
            user.plan = 'pro';
            await adapter.update({ model: 'user', where: [{ field: 'id', value: payment.userId }], update: { plan: 'pro' } });
        },
        latest: async () => [...payments.values()].filter(payment => payment.status === 'paid' || payment.paymentStatus === 'paid'),
        history: async (userId) => [...payments.values()].filter(payment => payment.userId === userId),
    };
    const stripe = {
        async createCheckout(form, key) {
            requests.push({ form, key });
            const role = form.get('metadata[role]');
            const id = `cs_test_${role}_${requests.length}`;
            const session = { id, status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, subscription: null,
                livemode: false, mode: form.get('mode'), payment_status: 'unpaid', currency: 'usd',
                amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
                client_reference_id: form.get('client_reference_id'),
                metadata: { integration: form.get('metadata[integration]'), userId: form.get('metadata[userId]'),
                    attempt: form.get('metadata[attempt]'), role } };
            checkouts.set(id, session);
            return session;
        },
        checkout: async id => checkouts.get(id),
        checkoutForSubscription: async id => [...checkouts.values()].find(item => item.subscription === id),
        subscription: async id => subscriptions.get(id),
        invoice: async id => invoices.get(id),
        portal: async () => ({ url: 'https://billing.stripe.com/p/session/test' }),
    };
    const listings = [];
    const tuitions = {
        createIndex: async () => 'fixture_slot', countDocuments: async () => 0,
        async insertOne(item) {
            if (item.freePostingSlot !== undefined && listings.some((existing) => existing.tutorId === item.tutorId && existing.freePostingSlot === item.freePostingSlot)) {
                throw new MongoServerError({ code: 11000, keyPattern: { freePostingSlot: 1 } });
            }
            listings.push(item);
        },
    };
    const api = createApi({ allowedOrigins: new Set(), checkDatabase: async () => true, auth, tuitions,
        billing: { origin, webhookSecret, stripe, store } }).listen(0, '127.0.0.1');
    await once(api, 'listening');
    context.after(() => new Promise(resolve => api.close(resolve)));
    const base = `http://127.0.0.1:${api.address().port}`;
    const call = (path, { method = 'GET', token, body, cookie, signature } = {}) => fetch(base + path, {
        method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(signature ? { 'Stripe-Signature': signature } : {}) }, body,
    });
    async function register(role, address = role) {
        const response = await call('/api/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: role,
            email: `${address}@example.com`, password: 'isolated-password-fixture', role: role === 'admin' ? 'student' : role }) });
        assert.equal(response.status, 200);
        const { user } = await response.json();
        const cookie = response.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0];
        if (role === 'admin') await adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { role } });
        users.set(user.id, { ...user, role });
        const result = await call('/api/auth/token', { cookie });
        return { id: user.id, token: (await result.json()).token };
    }
    const event = (type, id, { valid = true, livemode = false, metadata, eventId = 'evt_' + randomUUID().replaceAll('-', '') } = {}) => {
        const body = JSON.stringify({ id: eventId, livemode, type, created: Math.floor(Date.now() / 1000), data: { object: { id, metadata } } });
        return call('/api/payments/webhook', { method: 'POST', body, signature: valid ? sign(body) : 'invalid' });
    };
    const student = await register('student'), tutor = await register('tutor'), admin = await register('admin');
    const checkout = token => call('/api/payments/create-checkout-session', { method: 'POST', token,
        body: JSON.stringify({ amount: 1, role: 'admin', userId: admin.id }) });
    const postTuition = () => call('/api/tuitions', { method: 'POST', token: tutor.token,
        body: JSON.stringify({ title: 'Algebra tuition', subject: 'Math', classLevel: 'Class 9', mode: 'Online',
            monthlyFee: 2000, daysPerWeek: 2, description: 'Guided algebra tuition and weekly practice.' }) });
    assert.equal((await postTuition()).status, 201);
    assert.equal((await postTuition()).status, 201);
    assert.equal((await postTuition()).status, 409);
    assert.equal((await checkout()).status, 401);
    assert.equal((await checkout(admin.token)).status, 403);
    assert.equal((await checkout(student.token)).status, 200);
    assert.equal((await checkout(tutor.token)).status, 200);
    assert.equal((await checkout(tutor.token)).status, 200);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ form }) => form.get('line_items[0][price_data][unit_amount]')), ['1000', '1500']);
    assert.equal(requests[1].form.get('mode'), 'payment');
    assert.equal(requests[1].form.get('line_items[0][price_data][recurring][interval]'), null);
    assert.equal(requests[1].form.get('client_reference_id'), tutor.id);
    assert.ok(requests[1].key.startsWith('tutorlagbe-pro-once-'));
    const tutorSession = checkouts.get('cs_test_tutor_2');
    const studentSession = checkouts.get('cs_test_student_1');
    const status = (id, token) => call('/api/payments/status/' + id, { token });
    const statusValue = async (id, token) => (await (await status(id, token)).json()).status;
    const plan = async (token) => (await (await call('/api/auth/identity', { token })).json()).plan;
    assert.equal((await status(tutorSession.id, student.token)).status, 404);
    assert.equal(await statusValue(tutorSession.id, tutor.token), 'pending');
    assert.equal((await event('checkout.session.completed', tutorSession.id, { valid: false })).status, 400);
    Object.assign(tutorSession, { status: 'complete', payment_intent: 'pi_tutor', customer: 'cus_tutor' });
    assert.equal((await event('checkout.session.completed', tutorSession.id)).status, 200);
    assert.equal(await plan(tutor.token), 'free');

    tutorSession.payment_status = 'paid';
    assert.equal((await event('checkout.session.async_payment_succeeded', tutorSession.id, { livemode: true })).status, 200);
    assert.equal(await plan(tutor.token), 'free');
    tutorSession.amount_total = 1;
    assert.equal((await event('checkout.session.async_payment_succeeded', tutorSession.id)).status, 200);
    assert.equal(await plan(tutor.token), 'free');
    tutorSession.amount_total = 1500;
    tutorSession.currency = 'eur';
    assert.equal((await event('checkout.session.async_payment_succeeded', tutorSession.id)).status, 200);
    assert.equal(await plan(tutor.token), 'free');
    tutorSession.currency = 'usd';
    const originalReference = tutorSession.client_reference_id;
    tutorSession.client_reference_id = student.id;
    assert.equal((await event('checkout.session.async_payment_succeeded', tutorSession.id)).status, 200);
    assert.equal(await plan(tutor.token), 'free');
    tutorSession.client_reference_id = originalReference;
    users.get(tutor.id).role = 'student';
    assert.equal((await event('checkout.session.async_payment_succeeded', tutorSession.id)).status, 200);
    assert.equal(await plan(tutor.token), 'free');
    users.get(tutor.id).role = 'tutor';
    const deliver = () => event('checkout.session.async_payment_succeeded', tutorSession.id, { eventId: 'evt_tutor_success' });
    for (const response of await Promise.all([deliver(), deliver()])) assert.equal(response.status, 200);
    const payment = payments.get(tutorSession.id);
    assert.equal(payments.size, 2);
    assert.equal(payment.status, 'paid');
    assert.equal(payment.amount, 1500);
    assert.equal(payment.currency, 'usd');
    assert.equal(payment.userId, tutor.id);
    assert.equal(payment.userRole, 'tutor');
    assert.equal(payment.stripeSessionId, tutorSession.id);
    assert.equal(payment.transactionId, 'pi_tutor');
    assert.equal(payment.stripeCustomerId, 'cus_tutor');
    assert.equal(payment.stripeEventId, 'evt_tutor_success');
    assert.ok(payment.paidAt instanceof Date);
    assert.equal(await statusValue(tutorSession.id, tutor.token), 'active');
    assert.equal(await plan(tutor.token), 'pro');
    assert.equal((await postTuition()).status, 201);
    assert.equal((await checkout(tutor.token)).status, 409);
    assert.equal((await call('/api/payments/portal', { method: 'POST', token: tutor.token })).status, 404);

    studentSession.payment_intent = 'pi_student_failed';
    assert.equal((await event('payment_intent.payment_failed', studentSession.payment_intent, { metadata: studentSession.metadata })).status, 200);
    assert.equal(await statusValue(studentSession.id, student.token), 'failed');
    Object.assign(studentSession, { status: 'complete' });
    assert.equal((await event('checkout.session.async_payment_failed', studentSession.id)).status, 200);
    assert.equal(await plan(student.token), 'free');
    assert.equal((await checkout(student.token)).status, 200);
    const expired = checkouts.get('cs_test_student_3');
    expired.status = 'expired';
    assert.equal((await event('checkout.session.expired', expired.id)).status, 200);
    assert.equal(await statusValue(expired.id, student.token), 'expired');
    assert.equal((await checkout(student.token)).status, 200);
    const paid = checkouts.get('cs_test_student_4');
    Object.assign(paid, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_student' });
    assert.equal((await event('checkout.session.completed', paid.id)).status, 200);
    assert.equal(await plan(student.token), 'pro');
    assert.equal(payments.get(paid.id).amount, 1000);
    assert.equal((await call('/api/payments/history')).status, 401);
    const history = await (await call('/api/payments/history', { token: student.token })).json();
    assert.deepEqual(history.items.map(item => item.status), ['failed', 'expired', 'paid']);
    assert.ok(history.items.every(item => item.userId === student.id));
    assert.equal((await call('/api/payments/transactions', { token: tutor.token })).status, 403);
    assert.equal((await (await call('/api/payments/transactions', { token: admin.token })).json()).items.length, 2);

    const legacy = await register('tutor', 'legacy');
    const legacyMetadata = { integration: 'tutorlagbe-pro', userId: legacy.id, role: 'tutor' };
    checkouts.set('cs_test_legacy', { id: 'cs_test_legacy', status: 'complete', subscription: 'sub_legacy', metadata: legacyMetadata });
    const subscription = { id: 'sub_legacy', status: 'active', metadata: legacyMetadata, customer: 'cus_legacy' };
    subscriptions.set(subscription.id, subscription);
    const invoice = { id: 'in_legacy', subscription: subscription.id, currency: 'usd', status: 'paid',
        amount_paid: 1500, payment_intent: 'pi_legacy' };
    invoices.set(invoice.id, invoice);
    assert.equal((await event('invoice.paid', invoice.id)).status, 200);
    assert.equal((await call('/api/payments/portal', { method: 'POST', token: legacy.token })).status, 200);
    subscription.status = 'canceled';
    assert.equal((await event('customer.subscription.deleted', subscription.id)).status, 200);
    assert.equal(users.get(legacy.id).plan, 'free');
});
