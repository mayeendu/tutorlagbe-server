import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import type { Collection } from 'mongodb';

import { verifyToken } from './access.ts';
import { applicationRoutes, type Application } from './applications.ts';
import type { TutorAuth } from './auth.ts';
import { paymentRoutes, type BillingOptions } from './payments.ts';
import { getTeacher, listTeachers, profileRoutes } from './profiles.ts';
import { tuitionRoutes, type Tuition } from './tuitions.ts';
import { uploadRoutes } from './routes/upload.routes.ts';

interface ApiOptions {
    allowedOrigins: ReadonlySet<string>;
    checkDatabase: () => Promise<boolean>;
    auth?: TutorAuth;
    tuitions?: Collection<Tuition>;
    applications?: Collection<Application>;
    billing?: BillingOptions;
    imageUploadKey?: string;
}

export function createApi({ allowedOrigins, checkDatabase, auth, tuitions, applications, billing, imageUploadKey }: ApiOptions) {
    const app = express();
    app.disable('x-powered-by');

    app.use((request, response, next) => {
        response.vary('Origin');
        const origin = request.get('Origin');
        if (origin && allowedOrigins.has(origin)) {
            response.set('Access-Control-Allow-Origin', origin);
        }
        next();
    });

    app.options(['/', '/readyz'], (request, response) => {
        const origin = request.get('Origin');
        const method = request.get('Access-Control-Request-Method');
        response.vary('Access-Control-Request-Method');
        response.vary('Access-Control-Request-Headers');

        if (!origin || !allowedOrigins.has(origin) ||
            (method !== 'GET' && method !== 'HEAD') ||
            request.get('Access-Control-Request-Headers')) {
            response.status(403).json({ error: 'CORS request denied' });
            return;
        }

        response.set('Access-Control-Allow-Methods', 'GET, HEAD');
        response.sendStatus(204);
    });

    app.get('/', (_request, response) => {
        response.send('Server is running successfully!');
    });

    app.get('/readyz', async (_request, response) => {
        response.set('Cache-Control', 'no-store');
        const ready = await checkDatabase().catch(() => false);
        response.status(ready ? 200 : 503).json({ ready });
    });

    if (auth) {
        app.get('/api/auth/identity', verifyToken(auth), (_request, response) => {
            response.json(response.locals.identity);
        });
        const handleAuth = toNodeHandler(auth);
        app.all('/api/auth/{*path}', async (request, response) => {
            response.set('Cache-Control', 'no-store');
            await handleAuth(request, response);
        });
    } else {
        app.all('/api/auth/{*path}', (_request, response) => {
            response.set('Cache-Control', 'no-store').status(503)
                .json({ message: 'Express authentication is not configured. Check the Better Auth settings and MongoDB connection.' });
        });
    }

    if (tuitions) {
        app.use('/api/tuitions', tuitionRoutes(tuitions, auth));
    } else {
        app.use('/api/tuitions', (_request, response) => {
            response.status(503).json({ error: 'The tuition service is temporarily unavailable.' });
        });
    }

    app.get('/api/teachers', listTeachers(auth));
    app.get('/api/teachers/:id', getTeacher(auth));

    if (auth) app.use('/api/profiles', profileRoutes(auth));
    else app.use('/api/profiles', (_request, response) => {
        response.status(503).json({ error: 'Profile management is temporarily unavailable.' });
    });

    if (auth && applications && tuitions) app.use('/api/applications', applicationRoutes(auth, applications, tuitions));
    else app.use('/api/applications', (_request, response) => {
        response.status(503).json({ error: 'Applications are temporarily unavailable.' });
    });

    if (auth && billing) app.use('/api/payments', paymentRoutes(auth, billing));
    else app.use('/api/payments', (_request, response) => {
        response.status(503).json({ error: 'Billing is temporarily unavailable.' });
    });

    if (auth) app.use('/api/uploads', uploadRoutes(auth, imageUploadKey));
    else app.post('/api/uploads', (_request, response) => {
        response.status(503).json({ error: 'Image uploads are temporarily unavailable.' });
    });

    app.use((_request, response) => {
        response.status(404).json({ error: 'Route not found' });
    });

    return app;
}
