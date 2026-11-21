import express, { type ErrorRequestHandler } from 'express';
import { MongoServerError, ObjectId, type Collection, type Filter } from 'mongodb';
import { z } from 'zod';

import { verifyAdmin, verifyToken, verifyTutor, type AuthIdentity } from './access.ts';
import type { TutorAuth } from './auth.ts';
import { hostedImageUrl } from './routes/upload.routes.ts';

const mode = z.enum(['Online', 'Offline']);
const input = z.object({
    title: z.string().trim().min(3).max(100),
    subject: z.string().trim().min(2).max(60),
    classLevel: z.string().trim().min(2).max(40),
    mode,
    location: z.string().trim().max(100).default(''),
    monthlyFee: z.number().int().min(0).max(1_000_000),
    daysPerWeek: z.number().int().min(1).max(7),
    description: z.string().trim().min(20).max(2000),
    bannerImage: hostedImageUrl.optional(),
}).refine((value) => value.mode === 'Online' || value.location.length > 0, {
    path: ['location'], message: 'Enter a location for offline tuition',
});

const query = z.object({
    q: z.string().trim().max(100).optional(),
    subject: z.string().trim().max(60).optional(),
    classLevel: z.string().trim().max(40).optional(),
    mode: mode.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
});

const decision = z.object({ status: z.enum(['approved', 'rejected']), revision: z.number().int().positive().optional() });
const idSchema = z.string().regex(/^[\da-f]{24}$/i);
const publicFilter = { approvalStatus: 'approved', isActive: true } as const;
const pageSize = 24;

export type Tuition = z.infer<typeof input> & {
    _id: ObjectId;
    tutorId: string;
    tutorName: string;
    tutorEmail: string;
    approvalStatus: 'pending' | 'approved' | 'rejected';
    isActive: boolean;
    createdAt: Date;
    freeSlot?: number;
    revision?: number;
};

function listing(item: Tuition) {
    const { _id, title, subject, classLevel, mode, location, monthlyFee, daysPerWeek,
        description, bannerImage, tutorName, createdAt } = item;
    return { id: _id.toHexString(), title, subject, classLevel, mode, location,
        monthlyFee, daysPerWeek, description, bannerImage, tutorName, createdAt };
}

const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function managedListing(item: Tuition) {
    return { ...listing(item), approvalStatus: item.approvalStatus, isActive: item.isActive, revision: item.revision };
}

function ownerFilter(user: AuthIdentity): Filter<Tuition> {
    if (user.role === 'admin') return {};
    return { tutorId: user.id };
}

export function tuitionRoutes(collection: Collection<Tuition>, auth?: TutorAuth) {
    const router = express.Router();
    let slotIndex: Promise<string> | undefined;

    router.get('/', async (request, response) => {
        const filters = query.safeParse(request.query);
        if (!filters.success) {
            response.status(400).json({ error: 'Invalid tuition filters.' });
            return;
        }

        const { q, subject, classLevel, mode, page } = filters.data;
        const filter: Filter<Tuition> = { ...publicFilter };
        if (q) {
            const match = new RegExp(literal(q), 'i');
            filter.$or = [{ title: match }, { subject: match }];
        }
        if (subject) filter.subject = new RegExp(`^${literal(subject)}$`, 'i');
        if (classLevel) filter.classLevel = new RegExp(`^${literal(classLevel)}$`, 'i');
        if (mode) filter.mode = mode;

        const rows = await collection.find(filter).sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * pageSize).limit(pageSize + 1).toArray();
        response.json({ items: rows.slice(0, pageSize).map(listing), hasMore: rows.length > pageSize && page < 1000 });
    });

    if (auth) {
        const authenticate = verifyToken(auth);
        const parseJson = express.json({ limit: '16kb' });
        const verifyManager: express.RequestHandler = (_request, response, next) => {
            const user: AuthIdentity = response.locals.identity;
            if (user.role === 'student') {
                response.status(403).json({ error: 'Access denied.' });
                return;
            }
            next();
        };

        router.get('/manage', authenticate, verifyManager, async (request, response) => {
            const page = query.pick({ page: true }).safeParse(request.query);
            if (!page.success) {
                response.status(400).json({ error: 'Invalid page.' });
                return;
            }
            const rows = await collection.find(ownerFilter(response.locals.identity))
                .sort({ createdAt: -1, _id: -1 }).skip((page.data.page - 1) * pageSize).limit(pageSize + 1).toArray();
            response.json({ items: rows.slice(0, pageSize).map(managedListing), hasMore: rows.length > pageSize && page.data.page < 1000 });
        });

        const managed = express.Router({ mergeParams: true });
        router.use('/manage/:id', authenticate, verifyManager, managed);
        managed.use((request, response, next) => {
            const id = idSchema.safeParse(request.params.id);
            if (!id.success) {
                response.status(404).json({ error: 'Tuition not found.' });
                return;
            }
            response.locals.tuitionFilter = { _id: new ObjectId(id.data), ...ownerFilter(response.locals.identity) };
            next();
        });

        managed.get('/', async (_request, response) => {
            const row = await collection.findOne(response.locals.tuitionFilter);
            if (!row) {
                response.status(404).json({ error: 'Tuition not found.' });
                return;
            }
            response.json(managedListing(row));
        });

        managed.patch('/', parseJson, async (request, response) => {
            const parsed = input.safeParse(request.body);
            if (!parsed.success) {
                response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid tuition details.' });
                return;
            }
            const user: AuthIdentity = response.locals.identity;
            const row = await collection.findOneAndUpdate(response.locals.tuitionFilter, {
                $set: { ...parsed.data, ...(user.role === 'tutor' ? { approvalStatus: 'pending' } : {}) },
                $inc: { revision: 1 },
            }, { returnDocument: 'after' });
            if (!row) {
                response.status(404).json({ error: 'Tuition not found.' });
                return;
            }
            response.json(managedListing(row));
        });

        managed.delete('/', async (_request, response) => {
            const result = await collection.deleteOne(response.locals.tuitionFilter);
            if (!result.deletedCount) {
                response.status(404).json({ error: 'Tuition not found.' });
                return;
            }
            response.sendStatus(204);
        });

        router.post('/', authenticate, verifyTutor, parseJson, async (request, response) => {
            const parsed = input.safeParse(request.body);
            if (!parsed.success) {
                response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid tuition details.' });
                return;
            }

            const tutor = response.locals.identity;
            const item: Tuition = {
                ...parsed.data, _id: new ObjectId(), tutorId: tutor.id, tutorName: tutor.name,
                tutorEmail: tutor.email, approvalStatus: 'pending', isActive: true, createdAt: new Date(),
            };

            if (tutor.plan === 'pro') {
                await collection.insertOne(item);
                response.status(201).json({ ...listing(item), approvalStatus: item.approvalStatus });
                return;
            }

            slotIndex ??= collection.createIndex({ tutorId: 1, freeSlot: 1 }, {
                name: 'unique_tutor_free_slot', unique: true,
                partialFilterExpression: { freeSlot: { $exists: true } },
            }).catch((error: unknown) => {
                slotIndex = undefined;
                throw error;
            });
            await slotIndex;
            const untracked = await collection.countDocuments({
                freeSlot: { $exists: false },
                $or: [{ tutorId: tutor.id }, { tutorId: { $exists: false }, tutorEmail: tutor.email }],
            }, { limit: 2 });

            for (let freeSlot = 0; freeSlot < 2 - untracked; freeSlot++) {
                try {
                    await collection.insertOne({ ...item, freeSlot });
                    response.status(201).json({ ...listing(item), approvalStatus: item.approvalStatus });
                    return;
                } catch (error) {
                    if (!(error instanceof MongoServerError) || error.code !== 11000 ||
                        error.keyPattern?.freeSlot !== 1) throw error;
                }
            }
            response.status(409).json({ error: 'Free tutors can post up to two tuitions.' });
        });

        router.get('/moderation', authenticate, verifyAdmin, async (request, response) => {
            const page = query.pick({ page: true }).safeParse(request.query);
            if (!page.success) {
                response.status(400).json({ error: 'Invalid page.' });
                return;
            }
            const rows = await collection.find({ approvalStatus: 'pending' }).sort({ createdAt: 1, _id: 1 })
                .skip((page.data.page - 1) * pageSize).limit(pageSize + 1).toArray();
            response.json({ items: rows.slice(0, pageSize).map(managedListing), hasMore: rows.length > pageSize && page.data.page < 1000 });
        });

        router.patch('/:id/moderation', authenticate, verifyAdmin, parseJson, async (request, response) => {
            const id = idSchema.safeParse(request.params.id);
            const parsed = decision.safeParse(request.body);
            if (!id.success || !parsed.success) {
                response.status(400).json({ error: 'Invalid moderation request.' });
                return;
            }
            const result = await collection.updateOne({ _id: new ObjectId(id.data), approvalStatus: 'pending',
                revision: parsed.data.revision ?? { $exists: false } }, {
                $set: { approvalStatus: parsed.data.status },
            });
            if (!result.modifiedCount) {
                response.status(409).json({ error: 'This tuition changed or is no longer pending. Refresh the queue.' });
                return;
            }
            response.json({ approvalStatus: parsed.data.status });
        });
    } else {
        router.all(['/moderation', '/:id/moderation', '/manage', '/manage/:id'], (_request, response) => {
            response.status(503).json({ error: 'Authentication is temporarily unavailable.' });
        });
        router.post('/', (_request, response) => {
            response.status(503).json({ error: 'Authentication is temporarily unavailable.' });
        });
    }

    router.get('/:id', async (request, response) => {
        const id = idSchema.safeParse(request.params.id);
        const row = id.success ? await collection.findOne({ _id: new ObjectId(id.data), ...publicFilter }) : null;
        if (!row) {
            response.status(404).json({ error: 'Tuition not found.' });
            return;
        }
        response.json(listing(row));
    });

    const handleError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if (error.status === 400 || error.status === 413) {
            response.status(error.status).json({ error: 'Invalid request body.' });
            return;
        }
        response.status(503).json({ error: 'The tuition service is temporarily unavailable.' });
    };
    router.use(handleError);
    return router;
}
