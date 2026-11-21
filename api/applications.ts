import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { MongoServerError, ObjectId, type Collection, type Filter } from 'mongodb';
import { z } from 'zod';

import { verifyStudent, verifyToken, verifyTutor, type AuthIdentity } from './access.ts';
import type { TutorAuth } from './auth.ts';
import type { Tuition } from './tuitions.ts';

const id = z.string().regex(/^[\da-f]{24}$/i);
const page = z.coerce.number().int().min(1).max(1000).default(1);
const submission = z.strictObject({
    tuitionId: id,
    studentPhone: z.string().trim().min(7).max(30)
        .regex(/^[+\d(). -]+$/, 'Enter a valid phone number.')
        .refine((value) => value.replace(/\D/g, '').length >= 7, 'Enter a valid phone number.'),
    preferredSchedule: z.string().trim().min(3).max(160),
    studentNote: z.string().trim().max(1000).default(''),
});
const decision = z.strictObject({ status: z.enum(['accepted', 'rejected']) });
const reviewInput = z.strictObject({
    rating: z.number().int().min(1).max(5),
    feedback: z.string().trim().min(1, 'Enter your feedback.').max(1000),
});
const pageSize = 24;
const reviewPageSize = 10;
type TuitionReview = z.infer<typeof reviewInput> & { createdAt: Date };

export type Application = Omit<z.infer<typeof submission>, 'tuitionId'> & {
    _id: ObjectId;
    tuitionId: ObjectId;
    tuitionTitle: string;
    subject: string;
    monthlyFee: number;
    tutorId: string;
    tutorName: string;
    tutorEmail: string;
    studentId: string;
    studentName: string;
    studentEmail: string;
    status: 'pending' | 'accepted' | 'rejected';
    appliedAt: Date;
    review?: TuitionReview;
};

function reviewView({ rating, feedback, createdAt }: TuitionReview) {
    return { rating, feedback, createdAt };
}

function publicTuition(tuitionId: ObjectId) {
    return { _id: tuitionId, approvalStatus: 'approved', isActive: true } as const;
}

function applicationView(item: Application, forTutor: boolean) {
    const { tuitionTitle, subject, monthlyFee, status, preferredSchedule, appliedAt } = item;
    return { id: item._id.toHexString(), tuitionId: item.tuitionId.toHexString(), tuitionTitle, subject,
        monthlyFee, status, preferredSchedule, appliedAt,
        ...(forTutor
            ? { studentName: item.studentName, studentEmail: item.studentEmail, studentPhone: item.studentPhone, studentNote: item.studentNote }
            : { tutorName: item.tutorName, tutorEmail: item.tutorEmail, review: item.review && reviewView(item.review) }),
    };
}

export function listTuitionReviews(applications: Collection<Application>, tuitions: Collection<Tuition>): RequestHandler {
    return async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const tuition = id.safeParse(request.params.id);
        if (!tuition.success) {
            response.status(404).json({ error: 'Tuition not found.' });
            return;
        }
        const parsedPage = page.safeParse(request.query.page);
        if (!parsedPage.success) {
            response.status(400).json({ error: 'Invalid review page.' });
            return;
        }
        const tuitionId = new ObjectId(tuition.data);
        try {
            if (!await tuitions.findOne(publicTuition(tuitionId), { projection: { _id: 1 } })) {
                response.status(404).json({ error: 'Tuition not found.' });
                return;
            }
            const number = parsedPage.data;
            const rows = await applications.find({ tuitionId, status: 'accepted', review: { $exists: true } },
                { projection: { _id: 0, review: 1 } })
                .sort({ 'review.createdAt': -1, _id: -1 })
                .skip((number - 1) * reviewPageSize).limit(reviewPageSize + 1).toArray();
            response.json({
                items: rows.slice(0, reviewPageSize).flatMap(({ review }) => review ? [reviewView(review)] : []),
                hasMore: rows.length > reviewPageSize && number < 1000,
            });
        } catch {
            response.status(503).json({ error: 'Tuition reviews are temporarily unavailable.' });
        }
    };
}

export function applicationRoutes(auth: TutorAuth, applications: Collection<Application>, tuitions: Collection<Tuition>) {
    const router = express.Router();
    router.use(verifyToken(auth));
    const parseJson = express.json({ limit: '8kb' });
    let uniqueIndex: Promise<string> | undefined;

    router.post('/', verifyStudent, parseJson, async (request, response) => {
        const fields = submission.safeParse(request.body);
        if (!fields.success) {
            response.status(400).json({ error: fields.error.issues[0]?.message ?? 'Invalid application details.' });
            return;
        }

        const { tuitionId: rawId, ...details } = fields.data;
        const tuitionId = new ObjectId(rawId);
        const tuition = await tuitions.findOne(publicTuition(tuitionId));
        if (!tuition?.tutorId) {
            response.status(404).json({ error: 'This tuition is not accepting applications.' });
            return;
        }

        const student: AuthIdentity = response.locals.identity;
        const row: Application = {
            ...details, _id: new ObjectId(), tuitionId, tuitionTitle: tuition.title, subject: tuition.subject,
            monthlyFee: tuition.monthlyFee, tutorId: tuition.tutorId, tutorName: tuition.tutorName,
            tutorEmail: tuition.tutorEmail, studentId: student.id, studentName: student.name, studentEmail: student.email,
            status: 'pending', appliedAt: new Date(),
        };
        uniqueIndex ??= applications.createIndex({ studentId: 1, tuitionId: 1 }, {
            name: 'unique_student_tuition', unique: true,
        }).catch((error: unknown) => {
            uniqueIndex = undefined;
            throw error;
        });
        await uniqueIndex;
        try {
            await applications.insertOne(row);
        } catch (error) {
            if (!(error instanceof MongoServerError) || error.code !== 11000 ||
                error.keyPattern?.studentId !== 1 || error.keyPattern?.tuitionId !== 1) throw error;
            response.status(409).json({ error: 'You have already applied for this tuition.' });
            return;
        }
        response.status(201).json(applicationView(row, false));
    });

    const listQuery = z.object({
        page, tuitionId: id.optional(), status: z.enum(['pending', 'accepted', 'rejected']).optional(),
    });
    for (const [path, forTutor, guard] of [
        ['/mine', false, verifyStudent], ['/received', true, verifyTutor],
    ] as const) {
        router.get(path, guard, async (request, response) => {
            const query = listQuery.safeParse(request.query);
            if (!query.success) {
                response.status(400).json({ error: 'Invalid application filters.' });
                return;
            }
            const user: AuthIdentity = response.locals.identity;
            const filter: Filter<Application> = forTutor ? { tutorId: user.id } : { studentId: user.id };
            if (query.data.tuitionId) filter.tuitionId = new ObjectId(query.data.tuitionId);
            if (query.data.status) filter.status = query.data.status;
            const number = query.data.page;
            const rows = await applications.find(filter).sort({ appliedAt: -1, _id: -1 })
                .skip((number - 1) * pageSize).limit(pageSize + 1).toArray();
            response.json({ items: rows.slice(0, pageSize).map((item) => applicationView(item, forTutor)),
                hasMore: rows.length > pageSize && number < 1000 });
        });
    }

    router.post('/:id/review', verifyStudent, parseJson, async (request, response) => {
        const applicationId = id.safeParse(request.params.id);
        if (!applicationId.success) {
            response.status(404).json({ error: 'Application not found.' });
            return;
        }
        const input = reviewInput.safeParse(request.body);
        if (!input.success) {
            response.status(400).json({ error: input.error.issues[0]?.message ?? 'Invalid review.' });
            return;
        }
        const student: AuthIdentity = response.locals.identity;
        const ownerFilter = { _id: new ObjectId(applicationId.data), studentId: student.id };
        const application = await applications.findOne(ownerFilter);
        if (!application) {
            response.status(404).json({ error: 'Application not found.' });
            return;
        }
        if (application.status !== 'accepted') {
            response.status(403).json({ error: 'Only students with an accepted application can review this tuition.' });
            return;
        }
        if (!await tuitions.findOne(publicTuition(application.tuitionId), { projection: { _id: 1 } })) {
            response.status(404).json({ error: 'Tuition not found.' });
            return;
        }
        const review: TuitionReview = { ...input.data, createdAt: new Date() };
        const updated = await applications.findOneAndUpdate({
            ...ownerFilter, status: 'accepted', review: { $exists: false },
        }, { $set: { review } }, { returnDocument: 'after' });
        if (!updated) {
            response.status(409).json({ error: 'You can only submit one review for this tuition.' });
            return;
        }
        response.status(201).json(reviewView(review));
    });

    router.delete('/:id', verifyStudent, async (request, response) => {
        const parsed = id.safeParse(request.params.id);
        if (!parsed.success) {
            response.status(404).json({ error: 'Application not found.' });
            return;
        }
        const student: AuthIdentity = response.locals.identity;
        const filter = { _id: new ObjectId(parsed.data), studentId: student.id };
        const result = await applications.deleteOne({ ...filter, status: 'pending' });
        if (result.deletedCount) response.sendStatus(204);
        else if (await applications.findOne(filter)) response.status(409).json({ error: 'Only pending applications can be cancelled.' });
        else response.status(404).json({ error: 'Application not found.' });
    });

    router.patch('/:id/status', verifyTutor, parseJson, async (request, response) => {
        const parsed = id.safeParse(request.params.id);
        const input = decision.safeParse(request.body);
        if (!parsed.success || !input.success) {
            response.status(400).json({ error: 'Invalid application decision.' });
            return;
        }
        const tutor: AuthIdentity = response.locals.identity;
        const filter = { _id: new ObjectId(parsed.data), tutorId: tutor.id };
        const updated = await applications.findOneAndUpdate({ ...filter, status: 'pending' }, {
            $set: { status: input.data.status },
        }, { returnDocument: 'after' });
        if (updated) response.json(applicationView(updated, true));
        else if (await applications.findOne(filter)) response.status(409).json({ error: 'This application has already been reviewed.' });
        else response.status(404).json({ error: 'Application not found.' });
    });

    const onError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if (error.status === 400 || error.status === 413) {
            response.status(error.status).json({ error: 'Invalid application request.' });
            return;
        }
        response.status(503).json({ error: 'Applications are temporarily unavailable.' });
    };
    router.use(onError);
    return router;
}
