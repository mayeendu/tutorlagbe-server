import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { memoryAdapter } from 'better-auth/adapters/memory';
import { MongoServerError } from 'mongodb';

import { createApi } from '../api/app.ts';
import { createAuth } from '../api/auth.ts';
import { paymentStore } from '../api/payment-store.ts';

test('mock payments require opt-in and authentication, use role prices and persist each upgrade once', async (context) => {
    const origin = 'http://localhost:3000';
    const auth = createAuth({ database: memoryAdapter({ users: [], session: [], account: [], verification: [], jwks: [] }),
        userCollection: 'users', baseURL: origin, secret: 'isolated-development-mock-payment-test' });
    const { adapter } = await auth.$context;
    const accounts = new Map();
    const payments = new Map();
    let interruptPayment = false;
    const collections = {
        users: {
            async findOneAndUpdate(filter, update) {
                const account = accounts.get(filter._id.$in.at(-1));
                const plan = update.$set.plan;
                const marker = `mockPurchases.${plan}`;
                if (!account || account.role !== filter.role || !filter.plan.$in.includes(account.plan) || account.mockPurchases?.[plan]) return null;
                account.plan = plan;
                account.mockPurchases = { ...account.mockPurchases, [plan]: update.$set[marker] };
                await adapter.update({ model: 'user', where: [{ field: 'id', value: account.id }], update: { plan } });
                return account;
            },
            async findOne(filter) {
                const account = accounts.get(filter._id.$in.at(-1));
                return account?.role === filter.role ? account : null;
            },
        },
        payments: {
            async updateOne(filter, update) {
                if (interruptPayment) {
                    interruptPayment = false;
                    throw new Error('Interrupted payment write');
                }
                if (!payments.has(filter._id)) payments.set(filter._id, update.$setOnInsert);
            },
        },
    };
    const db = { collection: name => collections[name] };
    const client = { withSession: async () => {
        throw new MongoServerError({ code: 20, message: 'Transaction numbers are only allowed on a replica set member or mongos' });
    } };
    const mockPayments = paymentStore(client, db, 'users');
    async function start(nodeEnv, flag) {
        const previous = { NODE_ENV: process.env.NODE_ENV, ENABLE_MOCK_PAYMENTS: process.env.ENABLE_MOCK_PAYMENTS };
        let app;
        try {
            process.env.NODE_ENV = nodeEnv;
            process.env.ENABLE_MOCK_PAYMENTS = flag;
            app = createApi({ allowedOrigins: new Set(), checkDatabase: async () => true, auth, mockPayments });
        } finally {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
        const server = app.listen(0, '127.0.0.1');
        context.after(() => new Promise(resolve => server.close(resolve)));
        await once(server, 'listening');
        return `http://127.0.0.1:${server.address().port}`;
    }

    const disabled = await start('development', 'false');
    const production = await start('production', 'true');
    const enabled = await start('development', 'true');
    for (const base of [disabled, production]) {
        assert.equal((await fetch(base + '/api/payments/mock-checkout', { method: 'POST' })).status, 404);
        assert.equal((await (await fetch(base + '/api/payments/config')).json()).mockCheckout, false);
    }
    assert.deepEqual(await (await fetch(enabled + '/api/payments/config')).json(), { stripeTestCheckout: false, mockCheckout: true });

    async function register(role) {
        const response = await fetch(enabled + '/api/auth/sign-up/email', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({ name: role, email: `${role}@example.com`, password: 'isolated-test-password', role: role === 'admin' ? 'student' : role }),
        });
        assert.equal(response.status, 200);
        const { user } = await response.json();
        if (role === 'admin') await adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { role } });
        accounts.set(user.id, { ...user, role });
        const cookie = response.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0];
        const tokenResponse = await fetch(enabled + '/api/auth/token', { headers: { Cookie: cookie } });
        return { id: user.id, token: (await tokenResponse.json()).token };
    }

    const pay = (body, token) => fetch(enabled + '/api/payments/mock-checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    const currentPlan = async ({ token }) => {
        const response = await fetch(enabled + '/api/auth/identity', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200);
        return (await response.json()).plan;
    };
    const student = await register('student');
    const tutor = await register('tutor');
    const admin = await register('admin');

    assert.equal((await pay({ plan: 'pro' })).status, 401);
    assert.equal((await pay({ plan: 'pro' }, admin.token)).status, 403);
    assert.equal((await pay({ plan: 'free' }, student.token)).status, 400);
    assert.equal((await pay({ plan: 'pro', amount: 1 }, tutor.token)).status, 400);

    const requests = await Promise.all([pay({ plan: 'plus' }, student.token), pay({ plan: 'plus' }, student.token)]);
    const records = await Promise.all(requests.map(async response => {
        assert.equal(response.status, 200);
        return response.json();
    }));
    assert.deepEqual(records[0], records[1]);
    assert.equal(payments.size, 1);
    assert.equal(await currentPlan(student), 'plus');
    assert.equal(payments.get(records[0].paymentId).amount, 1000);
    assert.equal((await pay({ plan: 'pro' }, student.token)).status, 200);
    assert.equal(await currentPlan(student), 'pro');
    assert.equal(payments.get(`mock:${student.id}:pro`).amount, 1000);
    assert.equal((await pay({ plan: 'plus' }, student.token)).status, 200);
    assert.equal(await currentPlan(student), 'pro');

    interruptPayment = true;
    assert.equal((await pay({ plan: 'pro' }, tutor.token)).status, 503);
    assert.equal((await pay({ plan: 'pro' }, tutor.token)).status, 200);
    assert.equal(await currentPlan(tutor), 'pro');
    assert.equal((await pay({ plan: 'plus' }, tutor.token)).status, 409);
    const tutorPayment = payments.get(`mock:${tutor.id}:pro`);
    assert.equal(payments.size, 3);
    assert.deepEqual(
        [tutorPayment.userId, tutorPayment.userRole, tutorPayment.plan, tutorPayment.amount, tutorPayment.currency, tutorPayment.provider, tutorPayment.status],
        [tutor.id, 'tutor', 'pro', 1500, 'usd', 'mock', 'paid'],
    );
    assert.ok(tutorPayment.paidAt instanceof Date);
    assert.equal(tutorPayment.createdAt, tutorPayment.paidAt);
    assert.equal(tutorPayment.updatedAt, tutorPayment.paidAt);
});
