import 'dotenv/config';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { MongoClient } from 'mongodb';

import { createApi } from './app.ts';
import type { Application } from './applications.ts';
import { createAuth } from './auth.ts';
import type { CatalogChange } from './catalog.ts';
import { paymentStore } from './payment-store.ts';
import type { BillingOptions } from './payments.ts';
import { stripeGateway } from './stripe.ts';
import type { Tuition } from './tuitions.ts';

function start() {
    const port = Number(process.env.PORT ?? 8000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer from 1 to 65535.');
    }

    const defaultOrigins = process.env.NODE_ENV === 'production'
        ? ''
        : 'http://localhost:3000,http://127.0.0.1:3000';
    const allowedOrigins = new Set<string>();
    for (const entry of (process.env.CORS_ALLOWED_ORIGINS ?? defaultOrigins).split(',')) {
        const origin = entry.trim();
        if (!origin) continue;
        const url = URL.parse(origin);
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
            throw new Error('CORS_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins.');
        }
        allowedOrigins.add(origin);
    }

    const clients = new Map<string, MongoClient>();
    function getClient(uri: string, setting: string) {
        const existing = clients.get(uri);
        if (existing) return existing;
        try {
            const client = new MongoClient(uri, {
                serverSelectionTimeoutMS: 3000,
                connectTimeoutMS: 3000,
                socketTimeoutMS: 3000,
            });
            clients.set(uri, client);
            return client;
        } catch {
            throw new Error(`${setting} is invalid.`);
        }
    }

    const mongoUri = process.env.MONGODB_URI?.trim();
    if (mongoUri) getClient(mongoUri, 'MONGODB_URI');

    const secret = process.env.BETTER_AUTH_SECRET;
    const authUri = process.env.BETTER_AUTH_DB_URI?.trim();
    let auth: ReturnType<typeof createAuth> | undefined;
    let authOrigin: string | undefined;
    if (secret || authUri || process.env.BETTER_AUTH_URL) {
        const url = URL.parse(process.env.BETTER_AUTH_URL ?? '');
        const validUrl = url && ['http:', 'https:'].includes(url.protocol) &&
            url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
        const databaseUri = authUri || mongoUri;
        if (!secret || secret.trim().length < 32 || !databaseUri || !validUrl) {
            throw new Error('Configure BETTER_AUTH_SECRET (at least 32 characters), BETTER_AUTH_URL (the public origin), and BETTER_AUTH_DB_URI or MONGODB_URI.');
        }

        const client = getClient(databaseUri, authUri ? 'BETTER_AUTH_DB_URI' : 'MONGODB_URI');
        const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
        authOrigin = url.origin;
        auth = createAuth({
            database: mongodbAdapter(client.db('tutorlagbe_db'), { client }),
            baseURL: authOrigin,
            secret,
            google: clientId && clientSecret ? { clientId, clientSecret } : undefined,
        });
    }

    const tuitionUri = mongoUri || authUri;
    const data = tuitionUri ? clients.get(tuitionUri)?.db('tutorlagbe_db') : undefined;
    const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    const billingUri = authUri || mongoUri;
    const authClient = billingUri ? clients.get(billingUri) : undefined;
    let billing: BillingOptions | undefined;
    if (stripeSecret || webhookSecret) {
        if (!stripeSecret || !webhookSecret || !authOrigin || !authClient) {
            throw new Error('Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and Express authentication to enable billing.');
        }
        billing = { origin: authOrigin, webhookSecret,
            stripe: stripeGateway(stripeSecret), store: paymentStore(authClient, authClient.db('tutorlagbe_db')) };
    }
    const app = createApi({
        allowedOrigins,
        auth,
        billing,
        imageUploadKey: process.env.IMGBB_API_KEY?.trim(),
        tuitions: data?.collection<Tuition>('tuitions'),
        applications: data?.collection<Application>('applications'),
        catalog: data?.collection<CatalogChange>('catalog_changes'),
        checkDatabase: async () => {
            if (!clients.size) return false;
            await Promise.all([...clients.values()].map((client) => client.db('admin').command({ ping: 1 })));
            return true;
        },
    });

    const host = process.env.TUTORLAGBE_API_HOST?.trim() || undefined;
    const server = app.listen({ port, host }, () => console.info(`API listening on port ${port}`));
    server.on('error', (error: NodeJS.ErrnoException) => {
        console.error(`API could not listen on port ${port} (${error.code ?? 'unknown error'}).`);
        process.exitCode = 1;
    });

    function shutdown() {
        server.close(() => {
            void Promise.all([...clients.values()].map((client) => client.close())).catch(() => {
                console.error('Could not close the database connection.');
                process.exitCode = 1;
            });
        });
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

try {
    start();
} catch (error) {
    console.error(error instanceof Error ? error.message : 'API startup failed.');
    process.exitCode = 1;
}
