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

async function startAuthApi(context, tuitions, applications, imageUploadKey, catalog) {
    const database = memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] });
    const auth = createAuth({ database, baseURL: origin, secret });
    const app = express();
    app.get('/test/tutor', verifyToken(auth), verifyTutor, (_request, response) => response.sendStatus(204));
    app.get('/test/admin', verifyToken(auth), verifyAdmin, (_request, response) => response.sendStatus(204));
    app.use(createApi({ allowedOrigins: new Set(), checkDatabase: async () => true, auth, tuitions, applications, imageUploadKey, catalog }));

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
            const multipart = body instanceof FormData;
            if (body && !multipart) headers.set('Content-Type', 'application/json');
            return fetch(base + path, {
                method,
                headers,
                body: multipart ? body : body ? JSON.stringify(body) : undefined,
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
        async createIndex() { return 'unique_tutor_free_posting_slot'; },
        async countDocuments(filter) { return rows.filter((row) => matches(row, filter)).length; },
        async insertOne(row) {
            if ('freePostingSlot' in row && rows.some((other) => other.tutorId === row.tutorId && other.freePostingSlot === row.freePostingSlot)) {
                throw new MongoServerError({ code: 11000, keyPattern: { tutorId: 1, freePostingSlot: 1 } });
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
    assert.equal((await attempts.find((result) => result.status === 409).json()).code, 'TUITION_LIMIT_REACHED');
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

test('returns the Free posting limit before attempting to create the slot index', async (context) => {
    const rows = [];
    const collection = tuitionCollection(rows);
    collection.createIndex = async () => { throw new Error('Index creation unavailable'); };
    const { request } = await startAuthApi(context, collection);
    const tutor = await register(request, 'at-limit@example.com', 'tutor');
    rows.push({ tutorId: tutor.id, freeSlot: 0 }, { tutorEmail: 'at-limit@example.com' });

    const response = await request('/api/tuitions', { token: tutor.token, body: {
        title: 'Another math course', subject: 'Math', classLevel: 'Class 9', mode: 'Online',
        monthlyFee: 1500, daysPerWeek: 2, description: 'Practice algebra and geometry with guided exercises.',
    } });

    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'TUITION_LIMIT_REACHED');
    assert.equal(rows.length, 2);
});

test('duplicate legacy slots do not block first posts and existing courses count toward the limit', async (context) => {
    const rows = [];
    const collection = tuitionCollection(rows);
    collection.createIndex = async (keys, options) => {
        if ('freeSlot' in keys) throw new MongoServerError({ code: 11000, message: 'Duplicate legacy slots' });
        assert.deepEqual(keys, { tutorId: 1, freePostingSlot: 1 });
        assert.equal(options.unique, true);
        assert.deepEqual(options.partialFilterExpression, { freePostingSlot: { $exists: true } });
        return options.name;
    };
    const { request } = await startAuthApi(context, collection);
    const newTutor = await register(request, 'new-publisher@example.com', 'tutor');
    const existingTutor = await register(request, 'existing-publisher@example.com', 'tutor');
    rows.push(
        { tutorId: 'legacy-tutor', freeSlot: 0 },
        { tutorId: 'legacy-tutor', freeSlot: 0 },
        { tutorId: existingTutor.id, freeSlot: 0 },
    );
    const post = (token) => request('/api/tuitions', { token, body: {
        title: 'Math course', subject: 'Math', classLevel: 'Class 9', mode: 'Online',
        monthlyFee: 1500, daysPerWeek: 2, description: 'Practice algebra and geometry with guided exercises.',
    } });

    assert.equal((await post(newTutor.token)).status, 201);
    assert.equal((await post(newTutor.token)).status, 201);
    assert.equal((await post(newTutor.token)).status, 409);
    assert.equal((await post(existingTutor.token)).status, 201);
    assert.equal((await post(existingTutor.token)).status, 409);
    assert.equal(rows.filter((row) => row.tutorId === 'legacy-tutor').length, 2);
});

test('identifies a first-post index failure and retries initialization on the next request', async (context) => {
    const rows = [];
    const collection = tuitionCollection(rows);
    const createIndex = collection.createIndex;
    let indexAttempts = 0;
    collection.createIndex = async () => {
        if (++indexAttempts === 1) throw new MongoServerError({ code: 13, message: 'Unauthorized' });
        return createIndex();
    };
    const { request } = await startAuthApi(context, collection);
    const tutor = await register(request, 'first-post@example.com', 'tutor');
    const options = { token: tutor.token, body: {
        title: 'First math course', subject: 'Math', classLevel: 'Class 9', mode: 'Online',
        monthlyFee: 1500, daysPerWeek: 2, description: 'Practice algebra and geometry with guided exercises.',
    } };

    const failed = await request('/api/tuitions', options);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, 'TUITION_INDEX_13');
    assert.equal((await request('/api/tuitions', options)).status, 201);
    assert.equal(rows.length, 1);
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
    const bannerImage = 'https://i.ibb.co/example/tuition.png';
    const base = '/api/tuitions';
    const created = await request(base, { token: tutor.token, body: { ...course, bannerImage } });
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
    assert.equal((await (await request(base + '/' + id)).json()).bannerImage, bannerImage);
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

test('lists only public tutor fields in the teacher directory', async (context) => {
    const { request } = await startAuthApi(context);
    const tutor = await register(request, 'directory-tutor@example.com', 'tutor');
    const student = await register(request, 'directory-student@example.com', 'student');
    const image = 'https://i.ibb.co/example/teacher.png';
    assert.equal((await request('/api/profiles/me', { token: tutor.token, method: 'PATCH',
        body: { name: 'Directory Tutor', bio: 'Science tutor', image, phone: '+880 12345' } })).status, 200);

    const response = await request('/api/teachers');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [{ id: tutor.id, name: 'Directory Tutor', image,
        bio: 'Science tutor' }], hasMore: false });
    assert.deepEqual(await (await request('/api/teachers?page=2')).json(), { items: [], hasMore: false });
    assert.equal((await request('/api/teachers?page=0')).status, 400);
    const detail = await request(`/api/teachers/${tutor.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), { id: tutor.id, name: 'Directory Tutor', image, bio: 'Science tutor' });
    assert.equal((await request(`/api/teachers/${student.id}`)).status, 404);
});

test('students apply once, track or cancel pending applications, and only the owning tutor can review', async (context) => {
    const listings = [];
    const rows = [];
    const applications = {
        ...tuitionCollection(rows),
        async createIndex(keys, options) {
            assert.deepEqual(keys, { studentId: 1, tuitionId: 1 });
            assert.equal(options.unique, true);
            return options.name;
        },
        async insertOne(row) {
            if (rows.some((item) => item.studentId === row.studentId && item.tuitionId.equals(row.tuitionId))) {
                throw new MongoServerError({ code: 11000, keyPattern: { studentId: 1, tuitionId: 1 } });
            }
            rows.push(row);
        },
    };
    const { request } = await startAuthApi(context, tuitionCollection(listings), applications);
    const student = await register(request, 'applicant@example.com', 'student');
    const anotherStudent = await register(request, 'another-student@example.com', 'student');
    const tutor = await register(request, 'receiving-tutor@example.com', 'tutor');
    const stranger = await register(request, 'unrelated-tutor@example.com', 'tutor');
    const listing = { _id: new ObjectId(), title: 'Mathematics tuition', subject: 'Math', monthlyFee: 2400,
        tutorId: tutor.id, tutorName: 'Math Tutor', tutorEmail: 'receiving-tutor@example.com',
        approvalStatus: 'approved', isActive: true };
    listings.push(listing);
    const base = '/api/applications';
    const body = { tuitionId: listing._id.toHexString(), studentPhone: '+880 1712345678',
        preferredSchedule: 'Weekdays after 5 PM', studentNote: 'Preparing for exams.' };
    const apply = (token, input = body) => request(base, { token, body: input });
    assert.equal((await apply(undefined)).status, 401);
    assert.equal((await apply(tutor.token)).status, 403);
    assert.equal((await apply(student.token, { ...body, status: 'accepted' })).status, 400);
    assert.equal((await apply(student.token, { ...body, studentPhone: '.......' })).status, 400);
    listing.isActive = false;
    assert.equal((await apply(student.token)).status, 404);
    listing.isActive = true;
    listing.approvalStatus = 'pending';
    assert.equal((await apply(student.token)).status, 404);
    listing.approvalStatus = 'approved';

    const first = await Promise.all([apply(student.token), apply(student.token)]);
    assert.deepEqual(first.map((response) => response.status).sort(), [201, 409]);
    const created = await first.find((response) => response.status === 201).json();
    assert.equal(created.status, 'pending');
    assert.equal(created.monthlyFee, listing.monthlyFee);
    assert.equal(created.tutorEmail, listing.tutorEmail);
    assert.equal('studentPhone' in created, false);
    const mine = await (await request(base + '/mine?tuitionId=' + body.tuitionId, { token: student.token })).json();
    assert.deepEqual(mine.items.map(({ id }) => id), [created.id]);
    const acceptedCourses = async (token) =>
        (await (await request(base + '/mine?status=accepted', { token })).json()).items;
    assert.deepEqual(await acceptedCourses(student.token), []);
    assert.equal((await request(base + '/received', { token: student.token })).status, 403);
    assert.deepEqual((await (await request(base + '/mine', { token: anotherStudent.token })).json()).items, []);
    assert.deepEqual((await (await request(base + '/received', { token: stranger.token })).json()).items, []);
    const received = (await (await request(base + '/received', { token: tutor.token })).json()).items[0];
    assert.equal(received.studentEmail, 'applicant@example.com');
    assert.equal(received.studentPhone, body.studentPhone);
    assert.equal(received.studentNote, body.studentNote);

    const review = (token, status, target = created.id) => request(base + '/' + target + '/status', { token, method: 'PATCH', body: { status } });
    const cancel = (token, target = created.id) => request(base + '/' + target, { token, method: 'DELETE' });
    assert.equal((await review(stranger.token, 'accepted')).status, 404);
    assert.equal((await cancel(anotherStudent.token)).status, 404);
    assert.equal((await cancel(tutor.token)).status, 403);
    assert.equal((await review(tutor.token, 'accepted')).status, 200);
    assert.equal((await review(tutor.token, 'rejected')).status, 409);
    assert.equal((await cancel(student.token)).status, 409);
    assert.equal((await (await request(base + '/mine', { token: student.token })).json()).items[0].status, 'accepted');

    const second = await (await apply(anotherStudent.token)).json();
    assert.equal((await cancel(anotherStudent.token, second.id)).status, 204);
    assert.equal((await review(tutor.token, 'rejected', second.id)).status, 404);
    const reapplied = await (await apply(anotherStudent.token)).json();
    assert.equal((await review(tutor.token, 'rejected', reapplied.id)).status, 200);
    assert.equal((await (await request(base + '/mine', { token: anotherStudent.token })).json()).items[0].status, 'rejected');
    assert.deepEqual(await acceptedCourses(anotherStudent.token), []);

    const secondListing = { ...listing, _id: new ObjectId() };
    listings.push(secondListing);
    const racing = await (await apply(student.token, { ...body, tuitionId: secondListing._id.toHexString() })).json();
    assert.deepEqual((await acceptedCourses(student.token)).map(({ id }) => id), [created.id]);
    const [reviewed, cancelled] = await Promise.all([review(tutor.token, 'accepted', racing.id), cancel(student.token, racing.id)]);
    if (reviewed.status === 200) assert.equal(cancelled.status, 409);
    else {
        assert.equal(reviewed.status, 404);
        assert.equal(cancelled.status, 204);
    }
});

test('authenticates and bounds uploads, identifies image signatures, and hides ImgBB failures', async (context) => {
    const { request } = await startAuthApi(context, undefined, undefined, 'integration-test-key');
    const uploadPath = '/api/uploads';
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const jpeg = Buffer.from('ffd8ffe0', 'hex');
    const webp = Buffer.from('52494646040000005745425056503858', 'hex');
    const makeFile = (bytes) => {
        const body = new FormData();
        body.set('image', new Blob([bytes], { type: 'image/png' }), 'example.png');
        return body;
    };

    assert.equal((await request(uploadPath, { body: makeFile(png) })).status, 401);
    const registered = await request('/api/auth/sign-up/email', { body: account });
    assert.equal(registered.status, 200);
    const issued = await request('/api/auth/token', { cookie: sessionCookie(registered) });
    assert.equal(issued.status, 200);
    const { token } = await issued.json();
    const upload = (body) => request(uploadPath, { token, body, method: 'POST' });

    const originalFetch = globalThis.fetch;
    const providerCalls = [];
    let providerFails = false;
    context.mock.method(globalThis, 'fetch', async (target, options) => {
        const url = new URL(target);
        if (url.hostname !== 'api.imgbb.com') return originalFetch(target, options);

        assert.equal(url.pathname, '/1/upload');
        assert.equal(url.searchParams.get('key'), 'integration-test-key');
        assert.equal(options.method, 'POST');
        providerCalls.push(options.body.get('image').type);
        return providerFails
            ? Response.json({ error: 'private provider message' }, { status: 400 })
            : Response.json({ success: true, data: { url: 'https://i.ibb.co/example/image.png' } });
    });

    assert.equal((await upload({ image: 'text' })).status, 415);
    assert.equal((await upload(makeFile(Buffer.from('not an image')))).status, 415);
    assert.equal((await upload(makeFile(Buffer.alloc(3 * 1024 * 1024 + 1)))).status, 413);
    assert.deepEqual(providerCalls, []);

    const atLimit = Buffer.alloc(3 * 1024 * 1024);
    png.copy(atLimit);
    for (const bytes of [atLimit, jpeg, webp]) {
        const response = await upload(makeFile(bytes));
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { imageUrl: 'https://i.ibb.co/example/image.png' });
    }
    assert.deepEqual(providerCalls, ['image/png', 'image/jpeg', 'image/webp']);

    providerFails = true;
    const failure = await upload(makeFile(png));
    assert.equal(failure.status, 502);
    assert.deepEqual(await failure.json(), { error: 'Image hosting is temporarily unavailable. Try again.' });
});

test('catalog edits, images and deletes require a current admin role', async (context) => {
    const rows = new Map();
    const catalog = {
        find: () => ({ toArray: async () => [...rows.values()] }),
        async updateOne(filter, update, { upsert } = {}) {
            const existing = rows.get(filter._id);
            if (filter.deleted && existing?.deleted) {
                if (upsert) throw new MongoServerError({ code: 11000, message: 'Duplicate key' });
                return { matchedCount: 0 };
            }
            const row = existing ?? { _id: filter._id };
            for (const [key, value] of Object.entries(update.$set)) {
                if (key.startsWith('fields.')) (row.fields ??= {})[key.slice(7)] = value;
                else row[key] = value;
            }
            if (update.$unset?.fields === '') delete row.fields;
            rows.set(row._id, row);
            return { matchedCount: Number(Boolean(existing)) };
        },
    };
    const { auth, request } = await startAuthApi(context, undefined, undefined, undefined, catalog);
    const student = await register(request, 'catalog-student@example.com', 'student');
    const tutor = await register(request, 'catalog-tutor@example.com', 'tutor');
    const admin = await register(request, 'catalog-admin@example.com', 'student');
    const { adapter } = await auth.$context;
    await adapter.update({ model: 'user', where: [{ field: 'id', value: admin.id }], update: { role: 'admin' } });

    const base = '/api/catalog';
    const course = base + '/courses/algebra-and-geometry-essentials';
    const resource = base + '/resources/solving-linear-equations';
    const patch = (path, token, body) => request(path, { method: 'PATCH', token, body });
    const remove = (path, token) => request(path, { method: 'DELETE', token });
    const image = { imageUrl: 'https://i.ibb.co/test/cover.webp' };
    assert.equal((await patch(course, undefined, image)).status, 401);
    assert.equal((await patch(course, student.token, image)).status, 403);
    assert.equal((await patch(course, tutor.token, image)).status, 403);
    assert.equal((await remove(resource, tutor.token)).status, 403);
    assert.equal((await patch(course, admin.token, { imageUrl: 'https://example.com/cover.webp' })).status, 400);
    assert.equal((await patch(course, admin.token, image)).status, 204);
    assert.equal((await patch(course, admin.token, {
        title: 'Updated course', topic: 'Math', classLevel: 'SSC', level: 'Beginner',
        mode: 'Online', duration: '1 hour', fee: 500, description: 'Course description', outcomes: ['Practice skills'],
    })).status, 204);
    assert.equal((await patch(resource, student.token, image)).status, 403);
    assert.equal((await patch(resource, admin.token, { imageUrl: 'https://example.com/cover.webp' })).status, 400);
    assert.equal((await patch(resource, admin.token, image)).status, 204);
    assert.equal((await patch(resource, admin.token, {
        title: 'Updated resource', subject: 'Math', level: 'SSC', kind: 'Study notes',
        summary: 'Resource summary', lesson: 'Lesson', practice: 'Question', answer: 'Answer',
    })).status, 204);
    const changes = await (await request(base)).json();
    assert.equal(changes['courses/algebra-and-geometry-essentials'].fields.imageUrl, image.imageUrl);
    assert.equal(changes['resources/solving-linear-equations'].fields.title, 'Updated resource');
    assert.equal(changes['resources/solving-linear-equations'].fields.imageUrl, image.imageUrl);
    assert.equal((await remove(resource, admin.token)).status, 204);
    assert.equal((await remove(course, admin.token)).status, 204);
    assert.equal((await patch(course, admin.token, image)).status, 404);
    assert.deepEqual(await (await request(base)).json(), {
        'courses/algebra-and-geometry-essentials': { deleted: true },
        'resources/solving-linear-equations': { deleted: true },
    });
});
