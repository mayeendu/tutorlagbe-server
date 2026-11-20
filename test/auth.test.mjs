import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { memoryAdapter } from 'better-auth/adapters/memory';
import express from 'express';

import { verifyAdmin, verifyToken, verifyTutor } from '../api/access.ts';
import { createApi } from '../api/app.ts';
import { createAuth } from '../api/auth.ts';

const origin = 'https://tutorlagbe.example';
const secret = 'isolated-test-secret-only-89e77283d2724519';
const account = {
    name: 'Sample Tutor',
    email: 'tutor@example.com',
    password: 'test-password-only',
    role: 'tutor',
};

async function startAuthApi(context) {
    const database = memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] });
    const auth = createAuth({ database, baseURL: origin, secret });
    const app = express();
    app.get('/test/tutor', verifyToken(auth), verifyTutor, (_request, response) => response.sendStatus(204));
    app.get('/test/admin', verifyToken(auth), verifyAdmin, (_request, response) => response.sendStatus(204));
    app.use(createApi({ allowedOrigins: new Set(), checkDatabase: async () => true, auth }));

    const server = app.listen(0, '127.0.0.1');
    context.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        auth,
        request: (path, { cookie, token, body } = {}) => {
            const headers = new Headers({ Origin: origin });
            if (cookie) headers.set('Cookie', cookie);
            if (token) headers.set('Authorization', `Bearer ${token}`);
            if (body) headers.set('Content-Type', 'application/json');
            return fetch(base + path, {
                method: body ? 'POST' : 'GET',
                headers,
                body: body ? JSON.stringify(body) : undefined,
            });
        },
    };
}

function sessionCookie(response) {
    const cookie = response.headers.getSetCookie().find((value) => value.includes('session_token='));
    assert.ok(cookie);
    assert.match(cookie, /\bHttpOnly\b/i);
    assert.match(cookie, /\bSecure\b/i);
    assert.match(cookie, /\bSameSite=Lax\b/i);
    return cookie.split(';', 1)[0];
}

test('signs up, restores the session, verifies JWTs and current roles, then revokes on sign-out', async (context) => {
    const { auth, request } = await startAuthApi(context);
    const identityPath = '/api/auth/identity';
    assert.equal((await request(identityPath)).status, 401);

    const registered = await request('/api/auth/sign-up/email', { body: account });
    assert.equal(registered.status, 200);
    let cookie = sessionCookie(registered);
    const user = (await registered.json()).user;
    assert.equal(user.role, 'tutor');
    assert.equal(user.plan, 'free');

    const session = await request('/api/auth/get-session', { cookie });
    assert.equal((await session.json()).user.id, user.id);
    const issued = await request('/api/auth/token', { cookie });
    assert.equal(issued.status, 200);
    const { token } = await issued.json();
    const identity = await request(identityPath, { token });
    assert.equal(identity.status, 200);
    assert.deepEqual(await identity.json(), {
        id: user.id, name: user.name, email: user.email, role: 'tutor', plan: 'free',
    });

    assert.equal((await request('/test/tutor', { token })).status, 204);
    assert.equal((await request('/test/admin', { token })).status, 403);
    const [header, , signature] = token.split('.');
    assert.equal((await request(identityPath, { token: `${header}.e30.${signature}` })).status, 401);

    const { adapter } = await auth.$context;
    await adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { role: 'student' } });
    assert.equal((await request('/test/tutor', { token })).status, 403);
    assert.equal((await (await request(identityPath, { token })).json()).role, 'student');

    const signedOut = await request('/api/auth/sign-out', { cookie, body: {} });
    assert.equal(signedOut.status, 200);
    assert.equal((await request(identityPath, { token })).status, 401);

    const signedIn = await request('/api/auth/sign-in/email', {
        body: { email: account.email, password: account.password },
    });
    assert.equal(signedIn.status, 200);
    cookie = sessionCookie(signedIn);
    assert.equal((await (await request('/api/auth/get-session', { cookie })).json()).user.id, user.id);
});

test('rejects admin registration and self-service role changes', async (context) => {
    const { request } = await startAuthApi(context);
    const admin = await request('/api/auth/sign-up/email', { body: { ...account, role: 'admin' } });
    assert.equal(admin.status, 400);

    const registered = await request('/api/auth/sign-up/email', { body: account });
    const cookie = sessionCookie(registered);
    const elevated = await request('/api/auth/update-user', { cookie, body: { role: 'student' } });
    assert.equal(elevated.status, 400);
    assert.equal((await (await request('/api/auth/get-session', { cookie })).json()).user.role, 'tutor');
});
