import express, { Router, type ErrorRequestHandler } from 'express';
import { MongoServerError, type Collection } from 'mongodb';
import { z } from 'zod';

import { verifyAdmin, verifyToken } from './access.ts';
import type { TutorAuth } from './auth.ts';
import { hostedImageUrl } from './routes/upload.routes.ts';

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const courseFields = z.strictObject({
    title: text(160), topic: text(80), description: text(4000), duration: text(80),
    level: z.enum(['Beginner', 'Intermediate']), mode: z.enum(['Online', 'Physical']),
    classLevel: z.enum(['HSC', 'SSC', 'Honours', 'Degree', 'O-level']),
    fee: z.number().int().min(0).max(1000000),
    outcomes: z.array(text(300)).min(1).max(20),
    imageUrl: hostedImageUrl.optional(),
});
const resourceFields = z.strictObject({
    title: text(160), subject: text(80), level: text(80), kind: text(80),
    summary: text(1000), lesson: text(8000), practice: text(4000), answer: text(4000),
});
const catalogImage = z.strictObject({ imageUrl: hostedImageUrl });
const kindSchema = z.enum(['courses', 'resources']);
const slugSchema = z.string().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export type CatalogChange = {
    _id: string;
    deleted?: boolean;
    fields?: z.infer<typeof courseFields> | z.infer<typeof resourceFields> | z.infer<typeof catalogImage>;
};

export function catalogRoutes(store: Collection<CatalogChange>, auth?: TutorAuth) {
    const router = Router();
    router.use((_request, response, next) => {
        response.set('Cache-Control', 'no-store');
        next();
    });

    router.get('/', async (_request, response) => {
        const changes = await store.find().toArray();
        response.json(Object.fromEntries(changes.map(({ _id, ...change }) => [_id, change])));
    });

    if (auth) {
        router.use('/:kind/:slug', verifyToken(auth), verifyAdmin);
        router.patch('/:kind/:slug', express.json({ limit: '96kb' }), async (request, response) => {
            const kind = kindSchema.safeParse(request.params.kind);
            const slug = slugSchema.safeParse(request.params.slug);
            if (!kind.success || !slug.success) {
                response.status(404).json({ error: 'Catalog entry not found.' });
                return;
            }
            const schema = kind.data === 'courses' ? courseFields : resourceFields;
            const result = schema.safeParse(request.body);
            const image = catalogImage.safeParse(request.body).data;
            if (!result.success && !image) {
                response.status(400).json({ error: 'Check the catalog fields and try again.' });
                return;
            }
            const key = kind.data + '/' + slug.data;
            const filter = { _id: key, deleted: { $ne: true } };
            const fields = image ?? result.data;
            const update = { $set: Object.fromEntries(
                Object.entries(fields ?? {}).map(([field, value]) => [`fields.${field}`, value]),
            ) };
            try {
                await store.updateOne(filter, update, { upsert: true });
            } catch (error) {
                if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
                const retry = await store.updateOne(filter, update);
                if (!retry.matchedCount) {
                    response.status(404).json({ error: 'Catalog entry not found.' });
                    return;
                }
            }
            response.sendStatus(204);
        });

        router.delete('/:kind/:slug', async (request, response) => {
            const kind = kindSchema.safeParse(request.params.kind);
            const slug = slugSchema.safeParse(request.params.slug);
            if (!kind.success || !slug.success) {
                response.status(404).json({ error: 'Catalog entry not found.' });
                return;
            }
            await store.updateOne({ _id: kind.data + '/' + slug.data },
                { $set: { deleted: true }, $unset: { fields: '' } }, { upsert: true });
            response.sendStatus(204);
        });
    }

    const handleError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if (error.status === 400 || error.status === 413) {
            response.status(error.status).json({ error: 'Invalid catalog request.' });
            return;
        }
        response.status(503).json({ error: 'The catalog is temporarily unavailable.' });
    };
    router.use(handleError);
    return router;
}
