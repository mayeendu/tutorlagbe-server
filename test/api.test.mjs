import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { MongoServerError } from 'mongodb';

import { createApi } from '../api/app.ts';

const frontend = 'http://localhost:3000';

async function startApi(context, checkDatabase = async () => true, tuitions, checkAuthDatabase) {
    const app = createApi({ allowedOrigins: new Set([frontend]), checkDatabase, tuitions, checkAuthDatabase });
    const server = app.listen(0, '127.0.0.1');
    context.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
}

test('preserves the root route and only grants CORS to configured origins', async (context) => {
    const url = await startApi(context);
    const response = await fetch(url, { headers: { Origin: frontend } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Server is running successfully!');
    assert.equal(response.headers.get('access-control-allow-origin'), frontend);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.match(response.headers.get('vary'), /Origin/);

    const foreign = await fetch(url, { headers: { Origin: 'https://other.example' } });
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
});

test('handles preflights for the existing read-only routes', async (context) => {
    const url = await startApi(context);
    const preflight = (origin, method) => fetch(`${url}/readyz`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': method },
    });

    const allowed = await preflight(frontend, 'GET');
    assert.equal(allowed.status, 204);
    assert.match(allowed.headers.get('access-control-allow-methods'), /GET/);
    assert.equal((await preflight('https://other.example', 'GET')).status, 403);
    assert.equal((await preflight(frontend, 'POST')).status, 403);
});

test('reports ready, returns JSON for unknown routes, and hides database errors', async (context) => {
    const healthy = await startApi(context);
    const ready = await fetch(`${healthy}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true });

    const missing = await fetch(`${healthy}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Route not found' });

    const unavailable = await startApi(context, async () => { throw new Error('Database details'); });
    const response = await fetch(`${unavailable}/readyz`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ready: false });

    const health = await fetch(`${unavailable}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const { status, timestamp } = await health.json();
    assert.equal(status, 'ok');
    assert.equal(new Date(timestamp).toISOString(), timestamp);
});

test('reports auth database health independently and keeps driver details out of HTTP and logs', async (context) => {
    const warn = context.mock.method(console, 'warn', () => {});
    const failure = new MongoServerError({ code: 18, message: 'private connection details' });
    const healthy = await startApi(context, async () => false, undefined, async () => {});
    const unhealthy = await startApi(context, undefined, undefined, async () => { throw failure; });
    const unconfigured = await startApi(context);
    for (const [origin, status, body] of [
        [healthy, 200, 'ok'], [unhealthy, 503, 'unavailable'], [unconfigured, 503, 'unavailable'],
    ]) {
        const response = await fetch(`${origin}/api/health/db`);
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { status: body });
    }
    assert.equal((await fetch(`${unhealthy}/readyz`)).status, 200);
    const warnings = warn.mock.calls.map(({ arguments: args }) => args);
    assert.ok(warnings.some(([, details]) => details?.code === 18));
    assert.ok(warnings.some(([, details]) => details?.reason === 'auth_not_configured'));
    assert.doesNotMatch(JSON.stringify(warnings), /private connection details/);
});

test('rejects invalid startup configuration without printing its value', () => {
    const result = spawnSync(process.execPath, ['api/start.ts'], {
        env: { ...process.env, PORT: '8000', CORS_ALLOWED_ORIGINS: 'invalid-origin' },
        encoding: 'utf8',
        timeout: 5000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CORS_ALLOWED_ORIGINS must contain/);
    assert.doesNotMatch(result.stderr, /invalid-origin/);
});

test('rejects wildcard auth origins at startup', () => {
    const result = spawnSync(process.execPath, ['api/start.ts'], {
        env: { ...process.env, CORS_ALLOWED_ORIGINS: 'https://tutorlagbe.example',
            BETTER_AUTH_TRUSTED_ORIGINS: 'https://*.vercel.app' },
        encoding: 'utf8',
        timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BETTER_AUTH_TRUSTED_ORIGINS must contain/);
    assert.doesNotMatch(result.stderr, /\*\.vercel\.app/);
});

test('production entry points trust and grant CORS to the exact Kappa origin only', () => {
    const script = `
        import { once } from 'node:events';
        const app = process.env.VERCEL_ENV
            ? (await import('./app.ts')).default
            : (await import('./api/runtime.ts')).createRuntime().app;
        const server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/auth/sign-out';
            for (const origin of ['https://tutorlagbe.example', 'https://tutor-lagbe-kappa.vercel.app', 'https://unrelated.vercel.app']) {
                const response = await fetch(endpoint, { method: 'POST', headers: { Origin: origin, Cookie: 'test=1' } });
                console.log(origin, response.status, response.headers.get('access-control-allow-origin'));
            }
        } finally {
            server.close();
        }
    `;
    for (const [environment, aliasStatus] of [['production', 200], ['', 200], ['preview', 403]]) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...process.env, NODE_ENV: 'production', VERCEL_ENV: environment, CORS_ALLOWED_ORIGINS: '',
                BETTER_AUTH_URL: 'https://tutorlagbe.example', BETTER_AUTH_TRUSTED_ORIGINS: '',
                BETTER_AUTH_SECRET: 'isolated-vercel-test-secret-placeholder',
                BETTER_AUTH_DB_URI: 'mongodb://127.0.0.1:27017', MONGODB_URI: '', TUTORLAGBE_USER_COLLECTION: 'user',
                STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' },
            encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('https://')), [
            'https://tutorlagbe.example 200 null',
            `https://tutor-lagbe-kappa.vercel.app ${aliasStatus} ${aliasStatus === 200 ? 'https://tutor-lagbe-kappa.vercel.app' : 'null'}`,
            'https://unrelated.vercel.app 403 null',
        ]);
    }
});

test('rejects an insecure or wildcard production auth base URL', () => {
    for (const baseURL of ['http://tutorlagbe.example', 'https://*.vercel.app']) {
        const result = spawnSync(process.execPath, ['api/start.ts'], {
            env: { ...process.env, NODE_ENV: 'production', BETTER_AUTH_URL: baseURL,
                BETTER_AUTH_SECRET: 'isolated-production-test-secret-placeholder',
                BETTER_AUTH_DB_URI: 'mongodb://127.0.0.1:27017', CORS_ALLOWED_ORIGINS: '', BETTER_AUTH_TRUSTED_ORIGINS: '' },
            encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /BETTER_AUTH_URL \(the exact public frontend origin, HTTPS in production\)/);
        assert.ok(!result.stderr.includes(baseURL));
    }
});

test('rejects an unknown auth user collection instead of falling back to user', () => {
    const result = spawnSync(process.execPath, ['api/start.ts'], {
        env: { ...process.env, CORS_ALLOWED_ORIGINS: 'https://tutorlagbe.example',
            BETTER_AUTH_TRUSTED_ORIGINS: '', TUTORLAGBE_USER_COLLECTION: 'user-typo' },
        encoding: 'utf8',
        timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TUTORLAGBE_USER_COLLECTION must be user or users/);
    assert.doesNotMatch(result.stderr, /user-typo/);
});

test('reports catalog database failures without logging driver messages', async (context) => {
    const warning = context.mock.method(console, 'warn', () => {});
    const failure = new MongoServerError({ code: 13, message: 'private-driver-details' });
    const url = await startApi(context, async () => { throw failure; }, {
        find() { throw failure; },
    });
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    const response = await fetch(`${url}/api/tuitions`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'The tuition service is temporarily unavailable.' });
    assert.deepEqual(warning.mock.calls.map(({ arguments: args }) => args[1]?.code), [13, 13]);
    assert.doesNotMatch(JSON.stringify(warning.mock.calls.map(({ arguments: args }) => args)), /private-driver-details/);
});

test('reports disabled test billing without exposing settings', async (context) => {
    const url = await startApi(context);
    const config = await fetch(`${url}/api/payments/config`);
    assert.equal(config.status, 200);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), { stripeTestCheckout: false, mockCheckout: false });
    const checkout = await fetch(`${url}/api/payments/create-checkout-session`, { method: 'POST' });
    assert.equal(checkout.status, 503);
    assert.equal(checkout.headers.get('cache-control'), 'no-store');
    assert.equal((await checkout.json()).code, 'BILLING_NOT_CONFIGURED');
});

test('production reports billing readiness safely and keeps the API up with invalid Stripe settings', () => {
    const script = `
        import assert from 'node:assert/strict';
        import { once } from 'node:events';
        import { createRuntime } from './api/runtime.ts';
        for (const [key, signingSecret, ready] of [
            ['sk_test_fixture_private', '', false],
            ['sk_live_fixture_private', 'whsec_fixture_private', false],
            ['sk_test_fixture_private', 'whsec_fixture_private', true],
        ]) {
            process.env.STRIPE_SECRET_KEY = key;
            process.env.STRIPE_WEBHOOK_SECRET = signingSecret;
            const runtime = createRuntime();
            const server = runtime.app.listen(0, '127.0.0.1');
            await once(server, 'listening');
            try {
                const base = 'http://127.0.0.1:' + server.address().port;
                assert.equal((await fetch(base + '/health')).status, 200);
                assert.deepEqual(await (await fetch(base + '/api/payments/config')).json(),
                    { stripeTestCheckout: ready, mockCheckout: false });
                const checkout = await fetch(base + '/api/payments/create-checkout-session', { method: 'POST' });
                assert.equal(checkout.status, ready ? 401 : 503);
            } finally {
                await new Promise(resolve => server.close(resolve));
                await runtime.close();
            }
        }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://tutorlagbe.example',
            BETTER_AUTH_SECRET: 'isolated-billing-test-secret-placeholder',
            BETTER_AUTH_DB_URI: 'mongodb://127.0.0.1:27017', MONGODB_URI: '', TUTORLAGBE_USER_COLLECTION: 'user',
            CORS_ALLOWED_ORIGINS: '', BETTER_AUTH_TRUSTED_ORIGINS: '', ENABLE_MOCK_PAYMENTS: 'true' },
        encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const logs = result.stdout + result.stderr;
    assert.match(logs, /stripeWebhookSecretPresent: false/);
    assert.match(logs, /testKeyValid: false/);
    assert.match(logs, /billingReady: true/);
    assert.doesNotMatch(logs, /fixture_private/);
});
