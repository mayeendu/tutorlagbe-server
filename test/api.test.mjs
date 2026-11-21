import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { createApi } from '../api/app.ts';

const frontend = 'http://localhost:3000';

async function startApi(context, checkDatabase = async () => true) {
    const app = createApi({ allowedOrigins: new Set([frontend]), checkDatabase });
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

test('reports disabled test billing without exposing settings', async (context) => {
    const url = await startApi(context);
    const config = await fetch(`${url}/api/payments/config`);
    assert.equal(config.status, 200);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), { stripeTestCheckout: false, mockCheckout: false });
    const checkout = await fetch(`${url}/api/payments/create-checkout-session`, { method: 'POST' });
    assert.equal(checkout.status, 503);
    assert.equal((await checkout.json()).code, 'BILLING_NOT_CONFIGURED');
});
