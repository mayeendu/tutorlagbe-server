import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { memoryAdapter } from 'better-auth/adapters/memory';
import express from 'express';
import { MongoServerError, ObjectId } from 'mongodb';

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

async function startAuthApi(context, tuitions) {
    const database = memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] });
    const auth = createAuth({ database, baseURL: origin, secret });
    const app = express();
    app.get('/test/tutor', verifyToken(auth), verifyTutor, (_request, response) => response.sendStatus(204));
    app.get('/test/admin', verifyToken(auth), verifyAdmin, (_request, response) => response.sendStatus(204));
    app.use(createApi({ allowedOrigins: new Set(), checkDatabase: async () => true, auth, tuitions }));

    const server = app.listen(0, '127.0.0.1');
    context.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        auth,
        request: (path, { cookie, token, body, method = body ? 'POST' : 'GET' } = {}) => {
            const headers = new Headers({ Origin: origin });
            if (cookie) headers.set('Cookie', cookie);
            if (token) headers.set('Authorization', `Bearer ${token}`);
            if (body) headers.set('Content-Type', 'application/json');
            return fetch(base + path, {
                method,
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

function tuitionCollection(rows) {
    function matches(row, filter) {
        return Object.entries(filter).every(([key, value]) => {
            if (key === '$or') return value.some((part) => matches(row, part));
            if (value instanceof ObjectId) return row[key]?.equals(value);
            if (value instanceof RegExp) return value.test(row[key]);
            if (value && '$exists' in Object(value)) return (key in row) === value.$exists;
            return row[key] === value;
        });
    }

    return {
        async createIndex() { return 'unique_tutor_free_slot'; },
        async countDocuments(filter) { return rows.filter((row) => matches(row, filter)).length; },
        async insertOne(row) {
            if ('freeSlot' in row && rows.some((other) => other.tutorId === row.tutorId && other.freeSlot === row.freeSlot)) {
                throw new MongoServerError({ code: 11000, keyPattern: { tutorId: 1, freeSlot: 1 } });
            }
            rows.push(row);
        },
        find(filter) {
            let results = rows.filter((row) => matches(row, filter));
            return {
                sort() { return this; },
                skip(count) { results = results.slice(count); return this; },
                limit(count) { results = results.slice(0, count); return this; },
                async toArray() { return results; },
            };
        },
        async findOne(filter) { return rows.find((row) => matches(row, filter)); },
        async findOneAndUpdate(filter, update) {
            const row = rows.find((candidate) => matches(candidate, filter));
            if (!row) return null;
            Object.assign(row, update.$set);
            for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + amount;
            return row;
        },
        async deleteOne(filter) {
            const index = rows.findIndex((row) => matches(row, filter));
            if (index === -1) return { deletedCount: 0 };
            rows.splice(index, 1);
            return { deletedCount: 1 };
        },
        async updateOne(filter, update) {
            const row = rows.find((candidate) => matches(candidate, filter));
            if (row) Object.assign(row, update.$set);
            return { modifiedCount: row ? 1 : 0 };
        },
    };
}

test('limits concurrent Free posts and only publishes tuitions approved by an admin', async (context) => {
    const rows = [];
    const { auth, request } = await startAuthApi(context, tuitionCollection(rows));
    async function signUp(email, role) {
        const response = await request('/api/auth/sign-up/email', { body: { ...account, email, role } });
        assert.equal(response.status, 200);
        const cookie = sessionCookie(response);
        const { user } = await response.json();
        const { token } = await (await request('/api/auth/token', { cookie })).json();
        return { id: user.id, token };
    }

    const tutor = await signUp('publisher@example.com', 'tutor');
    const student = await signUp('learner@example.com', 'student');
    const admin = await signUp('reviewer@example.com', 'student');
    const { adapter } = await auth.$context;
    await adapter.update({ model: 'user', where: [{ field: 'id', value: admin.id }], update: { role: 'admin' } });

    const base = '/api/tuitions';
    const body = {
        title: 'Algebra [revision]', subject: 'Math', classLevel: 'Class 9', mode: 'Offline',
        location: 'Dhaka', monthlyFee: 2500, daysPerWeek: 2, description: 'Weekly guided practice for algebra and exam preparation.',
    };
    const post = (token, input = body) => request(base, { token, body: input });
    assert.equal((await post(undefined)).status, 401);
    assert.equal((await post(student.token)).status, 403);
    assert.equal((await post(tutor.token, { ...body, location: '' })).status, 400);

    const attempts = await Promise.all(Array.from({ length: 3 }, () => post(tutor.token, {
        ...body, tutorEmail: 'forged@example.com', approvalStatus: 'approved',
    })));
    assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 201, 409]);
    const created = await attempts.find((result) => result.status === 201).json();
    assert.equal(created.approvalStatus, 'pending');
    assert.equal(rows[0].tutorEmail, 'publisher@example.com');
    assert.equal((await request(base + '/' + created.id)).status, 404);
    assert.deepEqual((await (await request(base)).json()).items, []);

    const moderation = (id, token, status) => request(base + '/' + id + '/moderation', { token, method: 'PATCH', body: { status } });
    assert.equal((await request(base + '/moderation', { token: tutor.token })).status, 403);
    assert.equal((await (await request(base + '/moderation', { token: admin.token })).json()).items.length, 2);
    assert.equal((await moderation(created.id, tutor.token, 'approved')).status, 403);
    assert.equal((await moderation(created.id, admin.token, 'approved')).status, 200);
    assert.equal((await moderation(created.id, admin.token, 'rejected')).status, 409);

    const rejectedId = rows.find((row) => row._id.toHexString() !== created.id)._id.toHexString();
    assert.equal((await moderation(rejectedId, admin.token, 'rejected')).status, 200);
    assert.equal((await request(base + '/' + rejectedId)).status, 404);
    rows.push({ ...rows.find((row) => row._id.toHexString() === created.id), _id: new ObjectId(), isActive: false });
    const results = await (await request(base + '?q=%5Brevision%5D&subject=math&classLevel=Class+9&mode=Offline')).json();
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].id, created.id);
    assert.equal('tutorEmail' in results.items[0], false);
    assert.equal((await request(base + '/' + created.id)).status, 200);
    assert.deepEqual((await (await request(base + '?mode=Online')).json()).items, []);

    await adapter.update({ model: 'user', where: [{ field: 'id', value: tutor.id }], update: { plan: 'pro' } });
    assert.equal((await post(tutor.token)).status, 201);
});

test('enforces ownership for course edits and deletes and requires fresh moderation', async (context) => {
    const rows = [];
    const { auth, request } = await startAuthApi(context, tuitionCollection(rows));
    const tutor = await register(request, 'owner@example.com', 'tutor');
    const stranger = await register(request, 'other-tutor@example.com', 'tutor');
    const student = await register(request, 'reader@example.com', 'student');
    const admin = await register(request, 'admin@example.com', 'student');
    const { adapter } = await auth.$context;
    await adapter.update({ model: 'user', where: [{ field: 'id', value: admin.id }], update: { role: 'admin' } });

    const course = { title: 'Course to edit', subject: 'Math', classLevel: 'Class 9', mode: 'Online',
        monthlyFee: 2000, daysPerWeek: 2, description: 'Guided lessons and weekly practice for students.' };
    const base = '/api/tuitions';
    const created = await request(base, { token: tutor.token, body: course });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const managed = base + '/manage/' + id;
    const decide = revision => request(base + '/' + id + '/moderation', {
        token: admin.token, method: 'PATCH', body: { status: 'approved', revision },
    });
    const edit = (token, title) => request(managed, { token, method: 'PATCH', body: { ...course, title, tutorId: stranger.id } });
    const remove = token => request(managed, { token, method: 'DELETE' });
    assert.equal((await request(managed, { token: student.token })).status, 403);
    assert.equal((await request(managed, { token: stranger.token })).status, 404);
    assert.equal((await edit(stranger.token, 'Unauthorized edit')).status, 404);
    assert.equal((await remove(stranger.token)).status, 404);
    assert.deepEqual((await (await request(base + '/manage', { token: stranger.token })).json()).items, []);

    assert.equal((await decide()).status, 200);
    const changed = await edit(tutor.token, 'Teacher edit');
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).approvalStatus, 'pending');
    assert.equal(rows[0].tutorId, tutor.id);
    assert.equal((await request(base + '/' + id)).status, 404);
    assert.equal((await decide()).status, 409);
    assert.equal((await decide(1)).status, 200);
    const adminEdit = await edit(admin.token, 'Admin edit');
    assert.equal(adminEdit.status, 200);
    assert.equal((await adminEdit.json()).approvalStatus, 'approved');
    assert.equal((await remove(admin.token)).status, 204);
    assert.equal((await request(base + '/' + id)).status, 404);

    const next = await request(base, { token: tutor.token, body: course });
    const ownId = (await next.json()).id;
    assert.equal((await request(base + '/manage/' + ownId, { token: tutor.token, method: 'DELETE' })).status, 204);
});

async function register(request, email, role) {
    const response = await request('/api/auth/sign-up/email', { body: { ...account, email, role } });
    assert.equal(response.status, 200);
    const cookie = sessionCookie(response);
    const { user } = await response.json();
    const { token } = await (await request('/api/auth/token', { cookie })).json();
    return { id: user.id, token, cookie };
}

test('profiles support self edits and admin management without exposing auth fields', async (context) => {
    const { auth, request } = await startAuthApi(context);
    const student = await register(request, 'student-profile@example.com', 'student');
    const admin = await register(request, 'admin-profile@example.com', 'student');
    const { adapter } = await auth.$context;
    await adapter.update({ model: 'user', where: [{ field: 'id', value: admin.id }], update: { role: 'admin' } });

    const profiles = '/api/profiles';
    const target = profiles + '/' + student.id;
    const patch = (path, token, body) => request(path, { token, method: 'PATCH', body });
    const remove = (path, token) => request(path, { token, method: 'DELETE' });
    assert.equal((await request(profiles, { token: student.token })).status, 403);
    assert.equal((await request(profiles + '/' + admin.id, { token: student.token })).status, 403);
    assert.equal((await patch(profiles + '/me', student.token, { role: 'admin' })).status, 400);
    assert.equal((await remove(target, student.token)).status, 403);

    const updated = await patch(profiles + '/me', student.token, { name: 'New Name', bio: 'My profile', phone: '+880 12345' });
    assert.equal(updated.status, 200);
    const own = await updated.json();
    assert.equal(own.name, 'New Name');
    assert.equal(own.phone, '+880 12345');
    assert.equal((await (await request('/api/auth/get-session', { cookie: student.cookie })).json()).user.name, 'New Name');

    const listed = await (await request(profiles, { token: admin.token })).json();
    assert.equal(listed.items.length, 2);
    assert.equal('password' in listed.items[0] || 'token' in listed.items[0], false);
    assert.equal((await patch(target, admin.token, { bio: 'Admin updated' })).status, 200);
    assert.equal((await remove(profiles + '/me', admin.token)).status, 409);
    assert.equal((await remove(target, admin.token)).status, 204);
    assert.equal((await request(target, { token: admin.token })).status, 404);
    assert.equal((await request('/api/auth/identity', { token: student.token })).status, 401);
    const where = [{ field: 'userId', value: student.id }];
    assert.equal(await adapter.count({ model: 'account', where }), 0);
    assert.equal(await adapter.count({ model: 'session', where }), 0);

    const remaining = await register(request, 'remaining-admin@example.com', 'student');
    await adapter.update({ model: 'user', where: [{ field: 'id', value: remaining.id }], update: { role: 'admin' } });
    assert.equal((await remove(profiles + '/me', admin.token)).status, 204);
    assert.equal((await request('/api/auth/identity', { token: admin.token })).status, 401);
    assert.equal((await request(profiles, { token: remaining.token })).status, 200);
});
