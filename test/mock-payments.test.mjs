import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { MongoServerError } from 'mongodb';
import { createApi } from '../api/app.ts';
import { createAuth } from '../api/auth.ts';
import { paymentStore } from '../api/payment-store.ts';

test('demo checkout is isolated, owner-scoped, idempotent, and grants only expiring demo access', async (context) => {
    const origin = 'https://demo.example';
    const auth = createAuth({ database: memoryAdapter({ users: [], session: [], account: [], verification: [], jwks: [] }),
        userCollection: 'users', baseURL: origin, secret: 'isolated-development-mock-payment-test' });
    const accounts = new Map();
    const records = new Map();
    function find(filter) {
        return [...records.values()].find(row => Object.entries(filter).every(([key, value]) => {
            if (value?.$lte) return row[key] <= value.$lte;
            if (value?.$gt) return row[key] > value.$gt;
            return row[key] === value;
        }));
    }
    function update(filter, change) {
        const row = find(filter);
        if (!row) return null;
        Object.assign(row, change.$set);
        for (const key of Object.keys(change.$unset ?? {})) delete row[key];
        return row;
    }
    const collections = {
        users: {
            async findOne(filter) {
                const account = accounts.get(filter._id.$in.at(-1));
                return account?.role === filter.role ? account : null;
            },
        },
        payments: {
            createIndex: async () => 'fixture',
            async insertOne(payment) {
                if (find({ activeSlot: payment.activeSlot })) throw new MongoServerError({ code: 11000 });
                records.set(payment._id, payment);
            },
            findOne: async filter => find(filter) ?? null,
            updateOne: async (filter, change) => update(filter, change),
            findOneAndUpdate: async (filter, change) => update(filter, change),
            aggregate: ([{ $match }]) => ({
                toArray: async () => [...records.values()].filter(row =>
                    row.userId === $match.userId && (!$match.provider || row.provider !== $match.provider.$ne)),
            }),
        },
    };
    const store = paymentStore({}, { collection: name => collections[name] }, 'users');
    const tuitions = { countDocuments: async () => 2, insertOne: async () => ({ acknowledged: true }) };
    async function start(env, billing) {
        const prior = new Map(Object.keys(env).map(key => [key, process.env[key]]));
        let app;
        try {
            for (const [key, value] of Object.entries(env)) process.env[key] = value;
            app = createApi({ allowedOrigins: new Set(), checkDatabase: async () => true, auth, billing,
                paymentStore: store, mockPayments: store, tuitions });
        } finally {
            for (const [key, value] of prior) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
        const server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        context.after(() => new Promise(resolve => server.close(resolve)));
        return 'http://127.0.0.1:' + server.address().port;
    }
    const settings = { NODE_ENV: 'production', VERCEL_ENV: 'production', ENABLE_MOCK_PAYMENTS: 'true',
        ENABLE_DEMO_DEPLOYMENT: 'true', DEMO_FRONTEND_ORIGIN: origin, BETTER_AUTH_URL: origin };
    const productionWithDemoFlags = await start(settings);
    const production = await start({ ...settings, ENABLE_DEMO_DEPLOYMENT: '' });
    const disabled = await start({ ...settings, ENABLE_MOCK_PAYMENTS: '' });
    const publicAlias = await start({ ...settings, DEMO_FRONTEND_ORIGIN: 'https://tutorlagbe-client.vercel.app',
        BETTER_AUTH_URL: 'https://tutorlagbe-client.vercel.app' });
    const development = { ...settings, NODE_ENV: 'development', VERCEL_ENV: '', ENABLE_DEMO_DEPLOYMENT: '' };
    const enabled = await start(development);
    const stripeEnabled = await start(development, { origin, webhookSecret: 'fixture', stripe: {}, store });

    function call(path, { base = enabled, token, body, cookie } = {}) {
        return fetch(base + path, {
            method: body ? 'POST' : 'GET',
            headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    }
    const route = '/api/payments/mock-checkout';
    for (const base of [production, productionWithDemoFlags, disabled, publicAlias]) {
        assert.equal((await call(route, { base, body: { plan: 'plus' } })).status, 404);
        assert.equal((await (await call('/api/payments/config', { base })).json()).mockCheckout, false);
    }
    assert.deepEqual(await (await call('/api/payments/config')).json(), { stripeTestCheckout: false, stripeCheckoutPlans: [], mockCheckout: true });
    assert.deepEqual(await (await call('/api/payments/config', { base: stripeEnabled })).json(),
        { stripeTestCheckout: true, stripeCheckoutPlans: ['plus', 'pro'], mockCheckout: false });
    assert.equal((await call(route, { base: stripeEnabled, body: { plan: 'plus' } })).status, 404);
    async function register(role) {
        const result = await call('/api/auth/sign-up/email', {
            body: { name: role, email: role + '@example.invalid', password: 'test-fixture-password', role },
        });
        assert.equal(result.status, 200);
        const { user } = await result.json();
        accounts.set(user.id, user);
        const cookie = result.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0];
        const response = await call('/api/auth/token', { cookie });
        return (await response.json()).token;
    }
    const student = await register('student');
    const tutor = await register('tutor');
    const checkout = (token, plan) => call(route, { token, body: { plan } });
    const actions = { paid: 'pay', failed: 'fail', cancelled: 'cancel' };
    const settle = (token, id, status) => call(route + '/' + id, { token, body: { action: actions[status] } });
    const subscription = async token => (await (await call(route + '/subscription', { token })).json()).plan;
    assert.equal((await checkout(undefined, 'plus')).status, 401);
    assert.equal((await call(route, { token: student, body: { plan: 'pro', amount: 1 } })).status, 400);
    const results = await Promise.all([checkout(student, 'plus'), checkout(student, 'plus')]);
    assert.deepEqual(results.map(response => response.status), [201, 201]);
    const [first, duplicate] = await Promise.all(results.map(response => response.json()));
    assert.equal(first.id, duplicate.id);
    assert.equal(first.amount, 1000);
    assert.equal((await call(route + '/' + first.id, { base: productionWithDemoFlags, token: student, body: { action: 'pay' } })).status, 404);
    assert.equal((await call(route + '/' + first.id, { token: student, body: { action: 'paid' } })).status, 400);
    assert.equal(await subscription(student), 'free');
    assert.equal((await call(route + '/' + first.id, { token: tutor })).status, 404);
    assert.equal((await settle(tutor, first.id, 'paid')).status, 404);
    const outcomes = await Promise.all([settle(student, first.id, 'paid'), settle(student, first.id, 'paid')]);
    assert.deepEqual(outcomes.map(response => response.status), [200, 200]);
    assert.deepEqual(await outcomes[0].json(), await outcomes[1].json());
    assert.equal(records.size, 1);
    assert.equal(await subscription(student), 'plus');
    assert.equal((await settle(student, first.id, 'cancelled')).status, 409);
    assert.equal((await checkout(student, 'plus')).status, 409);

    for (const outcome of ['failed', 'cancelled', 'paid']) {
        const session = await (await checkout(tutor, 'pro')).json();
        assert.equal(session.amount, 1500);
        assert.equal((await (await settle(tutor, session.id, outcome)).json()).status, outcome);
        assert.equal(await subscription(tutor), outcome === 'paid' ? 'pro' : 'free');
        if (outcome !== 'paid') assert.equal((await settle(tutor, session.id, 'paid')).status, 409);
    }
    const history = await (await call('/api/payments/history', { token: tutor })).json();
    assert.deepEqual(history.items.map(item => item.status), ['failed', 'cancelled', 'paid']);
    assert(history.items.every(item => item.provider === 'mock'));
    assert.equal(history.demoSubscription.plan, 'pro');
    assert.equal((await (await call('/api/payments/history', { token: tutor, base: production })).json()).items.length, 0);
    assert.equal((await (await call('/api/auth/identity', { token: tutor })).json()).plan, 'free');

    const post = base => call('/api/tuitions', { base, token: tutor, body: {
        title: 'Algebra tuition', subject: 'Math', classLevel: 'Class 9', mode: 'Online',
        monthlyFee: 2000, daysPerWeek: 2, description: 'Guided algebra tuition and weekly practice.',
    } });
    assert.equal((await post(enabled)).status, 201);
    assert.equal((await post(production)).status, 409);
    const proPayment = history.items.find(item => item.status === 'paid');
    records.get(proPayment._id).entitlementExpiresAt = new Date(0);
    assert.equal(await subscription(tutor), 'free');
    assert.equal((await post(enabled)).status, 409);
    const abandoned = await (await checkout(tutor, 'pro')).json();
    records.get(abandoned.id).checkoutExpiresAt = new Date(0);
    assert.equal((await (await call(route + '/' + abandoned.id, { token: tutor })).json()).status, 'expired');
    assert.equal((await settle(tutor, abandoned.id, 'paid')).status, 409);
    assert.equal(records.get(abandoned.id).status, 'expired');
    assert.equal(await subscription(tutor), 'free');
});
