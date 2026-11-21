import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';

import { memoryAdapter } from 'better-auth/adapters/memory';
import { MongoServerError } from 'mongodb';

import { createApi } from '../api/app.ts';
import { createAuth } from '../api/auth.ts';
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

test('Stripe billing covers authenticated role prices, verified invoices, renewals and cancellation', async (context) => {
    const auth = createAuth({ database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
        baseURL: origin, secret: 'isolated-billing-auth-test-secret-631982' });
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
        latest: async () => [...payments.values()],
    };
    const stripe = {
        async createCheckout(form, key) {
            requests.push({ form, key });
            const role = form.get('metadata[role]');
            const id = `cs_test_${role}`;
            const session = { id, status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, subscription: null,
                metadata: { integration: 'tutorlagbe-pro', userId: form.get('metadata[userId]'), role } };
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
    async function register(role) {
        const response = await call('/api/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: role,
            email: `${role}@example.com`, password: 'isolated-password-fixture', role: role === 'admin' ? 'student' : role }) });
        assert.equal(response.status, 200);
        const { user } = await response.json();
        const cookie = response.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0];
        if (role === 'admin') await adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { role } });
        users.set(user.id, { ...user, role });
        const result = await call('/api/auth/token', { cookie });
        return { id: user.id, token: (await result.json()).token };
    }
    const event = (type, id, valid = true) => {
        const body = JSON.stringify({ type, created: Math.floor(Date.now() / 1000), data: { object: { id } } });
        return call('/api/payments/webhook', { method: 'POST', body, signature: valid ? sign(body) : 'invalid' });
    };
    const student = await register('student'), tutor = await register('tutor'), admin = await register('admin');
    const checkout = token => call('/api/payments/checkout', { method: 'POST', token });
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
    assert.equal(requests[1].form.get('mode'), 'subscription');
    assert.equal(requests[1].form.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.ok(requests[1].key.startsWith('tutorlagbe-pro-'));

    const session = checkouts.get('cs_test_tutor');
    Object.assign(session, { status: 'complete', subscription: 'sub_tutor' });
    const subscription = { id: 'sub_tutor', status: 'active', metadata: session.metadata, customer: 'cus_tutor' };
    subscriptions.set(subscription.id, subscription);
    const invoice = { id: 'in_first', subscription: subscription.id, currency: 'usd', status: 'paid', amount_paid: 1500, payment_intent: 'pi_first' };
    invoices.set(invoice.id, invoice);
    invoices.set('in_wrong', { ...invoice, id: 'in_wrong', amount_paid: 100 });
    const status = token => call('/api/payments/status/cs_test_tutor', { token });
    assert.equal((await status(student.token)).status, 404);
    assert.equal((await (await status(tutor.token)).json()).status, 'pending');
    assert.equal((await event('invoice.paid', invoice.id, false)).status, 400);
    assert.equal((await event('invoice.paid', 'in_wrong')).status, 200);
    assert.equal(payments.size, 0);
    for (const response of await Promise.all([event('invoice.paid', invoice.id), event('invoice.paid', invoice.id)])) assert.equal(response.status, 200);
    assert.equal(payments.size, 1);
    assert.equal((await (await status(tutor.token)).json()).status, 'active');
    assert.equal((await (await call('/api/auth/identity', { token: tutor.token })).json()).plan, 'pro');
    assert.equal((await postTuition()).status, 201);
    assert.equal((await checkout(tutor.token)).status, 409);
    assert.equal((await call('/api/payments/portal', { method: 'POST', token: tutor.token })).status, 200);

    invoices.set('in_renewal', { ...invoice, id: 'in_renewal', payment_intent: 'pi_renewal' });
    assert.equal((await event('invoice.paid', 'in_renewal')).status, 200);
    assert.equal(payments.size, 2);
    assert.equal((await call('/api/payments/transactions', { token: tutor.token })).status, 403);
    assert.equal((await (await call('/api/payments/transactions', { token: admin.token })).json()).items.length, 2);
    subscription.status = 'canceled';
    assert.equal((await event('customer.subscription.deleted', subscription.id)).status, 200);
    assert.equal(users.get(tutor.id).plan, 'free');
    assert.equal((await event('invoice.paid', 'in_renewal')).status, 200);
    assert.equal(users.get(tutor.id).plan, 'free');
    assert.equal(payments.size, 2);
});
