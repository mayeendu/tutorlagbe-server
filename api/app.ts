import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import type { Collection } from 'mongodb';

import { verifyToken } from './access.ts';
import { applicationRoutes, listTuitionReviews, type Application } from './applications.ts';
import type { TutorAuth } from './auth.ts';
import { catalogRoutes, type CatalogChange } from './catalog.ts';
import { databaseErrorDetails } from './database-error.ts';
import { mockPaymentRoutes, mockPaymentsEnabled } from './mock-payments.ts';
import type { PaymentStore } from './payment-store.ts';
import { paymentRoutes, type BillingOptions } from './payments.ts';
import { getTeacher, listTeachers, profileRoutes } from './profiles.ts';
import { tuitionRoutes, type SavedTuitionAccount, type Tuition } from './tuitions.ts';
import { uploadRoutes } from './routes/upload.routes.ts';

interface ApiOptions {
    allowedOrigins: ReadonlySet<string>;
    checkDatabase: () => Promise<boolean>;
    checkAuthDatabase?: () => Promise<void>;
    auth?: TutorAuth;
    tuitions?: Collection<Tuition>;
    savedTuitionAccounts?: Collection<SavedTuitionAccount>;
    applications?: Collection<Application>;
    catalog?: Collection<CatalogChange>;
    billing?: BillingOptions;
    mockPayments?: Pick<PaymentStore, 'mockCheckout'>;
    imageUploadKey?: string;
}

export function createApi({ allowedOrigins, checkDatabase, checkAuthDatabase, auth, tuitions, savedTuitionAccounts, applications, catalog, billing, mockPayments, imageUploadKey }: ApiOptions) {
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

    app.options(['/', '/health', '/readyz'], (request, response) => {
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

    app.get('/health', (_request, response) => {
        response.set('Cache-Control', 'no-store').json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    app.get('/readyz', async (_request, response) => {
        response.set('Cache-Control', 'no-store');
        const ready = await checkDatabase().catch((error: unknown) => {
            console.warn('MongoDB readiness check failed.', databaseErrorDetails(error));
            return false;
        });
        response.status(ready ? 200 : 503).json({ ready });
    });

    app.get('/api/health/db', async (_request, response) => {
        response.set('Cache-Control', 'no-store');
        if (!checkAuthDatabase) {
            console.warn('Auth database health check unavailable.', { reason: 'auth_not_configured' });
            response.status(503).json({ status: 'unavailable' });
            return;
        }
        try {
            await checkAuthDatabase();
            response.json({ status: 'ok' });
        } catch (error) {
            console.warn('Auth database ping failed.', databaseErrorDetails(error));
            response.status(503).json({ status: 'unavailable' });
        }
    });

    if (auth) {
        app.get('/api/auth/identity', verifyToken(auth), (_request, response) => {
            response.json(response.locals.identity);
        });
        const handleAuth = toNodeHandler(auth);
        app.all('/api/auth/{*path}', async (request, response) => {
            response.set('Cache-Control', 'no-store');
            try {
                await handleAuth(request, response);
            } catch (error) {
                console.error('Better Auth request failed.', databaseErrorDetails(error));
                if (!response.headersSent) {
                    response.status(500).json({ code: 'AUTH_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' });
                } else {
                    response.end();
                }
            }
        });
    } else {
        app.all('/api/auth/{*path}', (_request, response) => {
            response.set('Cache-Control', 'no-store').status(503)
                .json({ message: 'Express authentication is not configured. Check the Better Auth settings and MongoDB connection.' });
        });
    }

    if (applications && tuitions) app.get('/api/tuitions/:id/reviews', listTuitionReviews(applications, tuitions));
    if (tuitions) {
        app.use('/api/tuitions', tuitionRoutes(tuitions, auth, savedTuitionAccounts));
    } else {
        console.warn('Tuition catalog unavailable. Configure MONGODB_URI or BETTER_AUTH_DB_URI on the API service.');
        app.use('/api/tuitions', (_request, response) => {
            response.status(503).json({ error: 'The tuition service is temporarily unavailable.' });
        });
    }

    if (catalog) app.use('/api/catalog', catalogRoutes(catalog, auth));

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

    const mockCheckout = mockPaymentsEnabled();
    app.get('/api/payments/config', (_request, response) => {
        response.set('Cache-Control', 'no-store').json({ stripeTestCheckout: Boolean(auth && billing),
            mockCheckout: Boolean(mockCheckout && auth && mockPayments) });
    });
    if (mockCheckout && auth && mockPayments) app.use('/api/payments/mock-checkout', mockPaymentRoutes(auth, mockPayments));
    else app.post('/api/payments/mock-checkout', (_request, response) => {
        response.set('Cache-Control', 'no-store').status(404).json({ error: 'Route not found' });
    });
    if (auth && billing) app.use('/api/payments', paymentRoutes(auth, billing));
    else app.use('/api/payments', (_request, response) => {
        response.status(503).json({ error: 'Stripe billing has not been configured on the server.', code: 'BILLING_NOT_CONFIGURED' });
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
