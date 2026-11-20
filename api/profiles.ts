import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { verifyAdmin, verifyToken, type AuthIdentity } from './access.ts';
import type { TutorAuth } from './auth.ts';

const idSchema = z.string().regex(/^[\w-]{1,128}$/);
const pageSchema = z.coerce.number().int().min(1).max(1000).default(1);
const changes = z.strictObject({
    name: z.string().trim().min(2).max(100).optional(),
    phone: z.string().trim().max(30).regex(/^[+\d(). -]*$/).optional(),
    bio: z.string().trim().max(1000).optional(),
    image: z.url({ protocol: /^https?$/ }).max(2048)
        .refine((value) => { const url = URL.parse(value); return url && !url.username && !url.password; }, 'Enter a public photo URL.')
        .nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Enter a profile change.');

type Profile = AuthIdentity & { image?: string | null; phone?: string; bio?: string };

function profile({ id, name, email, role, plan, image, phone, bio }: Profile) {
    return { id, name, email, role, plan, image, phone, bio };
}

export function profileRoutes(auth: TutorAuth) {
    const router = express.Router();
    router.use(verifyToken(auth));
    const parseJson = express.json({ limit: '8kb' });

    router.get('/', verifyAdmin, async (request, response) => {
        const page = pageSchema.safeParse(request.query.page);
        if (!page.success) {
            response.status(400).json({ error: 'Invalid page.' });
            return;
        }
        const { adapter } = await auth.$context;
        const rows = await adapter.findMany<Profile>({ model: 'user', limit: 25,
            offset: (page.data - 1) * 24, sortBy: { field: 'id', direction: 'asc' } });
        response.json({ items: rows.slice(0, 24).map(profile), hasMore: rows.length > 24 && page.data < 1000 });
    });

    router.use('/:id', (request, response, next) => {
        const user: AuthIdentity = response.locals.identity;
        const id = idSchema.safeParse(request.params.id === 'me' ? user.id : request.params.id);
        if (!id.success) {
            response.status(404).json({ error: 'Profile not found.' });
            return;
        }
        if (user.id !== id.data && user.role !== 'admin') {
            response.status(403).json({ error: 'Access denied.' });
            return;
        }
        response.locals.profileId = id.data;
        next();
    });

    router.get('/:id', async (_request, response) => {
        const { adapter } = await auth.$context;
        const row = await adapter.findOne<Profile>({ model: 'user', where: [{ field: 'id', value: response.locals.profileId }] });
        if (!row) {
            response.status(404).json({ error: 'Profile not found.' });
            return;
        }
        response.json(profile(row));
    });

    router.patch('/:id', parseJson, async (request, response) => {
        const parsed = changes.safeParse(request.body);
        if (!parsed.success) {
            response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid profile details.' });
            return;
        }
        const { adapter } = await auth.$context;
        const row = await adapter.update<Profile>({ model: 'user', where: [{ field: 'id', value: response.locals.profileId }],
            update: { ...parsed.data, updatedAt: new Date() } });
        if (!row) {
            response.status(404).json({ error: 'Profile not found.' });
            return;
        }
        response.json(profile(row));
    });

    router.delete('/:id', verifyAdmin, async (_request, response) => {
        const id: string = response.locals.profileId;
        const actor: AuthIdentity = response.locals.identity;
        const { adapter } = await auth.$context;
        const result = await adapter.transaction(async (transaction) => {
            // Recheck and write the acting admin within the transaction. A concurrent
            // deletion of that admin then conflicts with this operation.
            const activeAdmin = await transaction.update({ model: 'user', where: [
                { field: 'id', value: actor.id }, { field: 'role', value: 'admin' },
            ], update: { updatedAt: new Date() } });
            if (!activeAdmin) return 403;
            if (id === actor.id) {
                const other = await transaction.findOne<Profile>({ model: 'user', where: [
                    { field: 'role', value: 'admin' }, { field: 'id', operator: 'ne', value: actor.id },
                ] });
                if (!other) return 409;
                const remaining = await transaction.update({ model: 'user', where: [
                    { field: 'id', value: other.id }, { field: 'role', value: 'admin' },
                ], update: { updatedAt: new Date() } });
                if (!remaining) return 409;
            }
            const target = await transaction.findOne({ model: 'user', where: [{ field: 'id', value: id }] });
            if (!target) return 404;
            const userRef = [{ field: 'userId', value: id }];
            await transaction.deleteMany({ model: 'session', where: userRef });
            await transaction.deleteMany({ model: 'account', where: userRef });
            await transaction.delete({ model: 'user', where: [{ field: 'id', value: id }] });
            return 204;
        });
        if (result === 403) response.status(403).json({ error: 'Access denied.' });
        else if (result === 404) response.status(404).json({ error: 'Profile not found.' });
        else if (result === 409) response.status(409).json({ error: 'The last admin account cannot be deleted.' });
        else response.sendStatus(204);
    });

    const onError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if (error.status === 400 || error.status === 413) {
            response.status(error.status).json({ error: 'Invalid profile request.' });
            return;
        }
        response.status(503).json({ error: 'Profile management is temporarily unavailable.' });
    };
    router.use(onError);
    return router;
}
