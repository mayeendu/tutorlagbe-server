import { fileURLToPath } from 'node:url';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';

import { createApi } from './app.ts';
import type { Application } from './applications.ts';
import { createAuth } from './auth.ts';
import type { CatalogChange } from './catalog.ts';
import { mockPaymentsEnabled } from './mock-payments.ts';
import { paymentStore } from './payment-store.ts';
import type { BillingOptions } from './payments.ts';
import { stripeGateway } from './stripe.ts';
import type { SavedTuitionAccount, Tuition } from './tuitions.ts';

function exactOrigins(value: string, setting: string) {
    return new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean).map((origin) => {
        const url = URL.parse(origin);
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.hostname.includes('*')) {
            throw new Error(`${setting} must contain comma-separated HTTP(S) origins.`);
        }
        return origin;
    }));
}

export function createRuntime() {
    if (process.env.npm_lifecycle_event === 'dev') process.env.NODE_ENV ??= 'development';
    const explicitAuthOrigin = process.env.BETTER_AUTH_URL?.trim();
    config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

    if (process.env.NODE_ENV === 'development' && !process.env.BETTER_AUTH_DB_URI?.trim() && !process.env.MONGODB_URI?.trim()) {
        const clientSettings: Record<string, string> = {};
        config({
            path: ['.env.development.local', '.env.local', '.env.development', '.env']
                .map((name) => fileURLToPath(new URL(`../../tutorlagbe-client/${name}`, import.meta.url))),
            processEnv: clientSettings,
            quiet: true,
        });
        const clientAuthOrigin = clientSettings.BETTER_AUTH_URL?.trim();
        if (!explicitAuthOrigin && clientAuthOrigin) process.env.BETTER_AUTH_URL = clientAuthOrigin;
        for (const key of ['BETTER_AUTH_DB_URI', 'BETTER_AUTH_SECRET',
            'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TUTORLAGBE_USER_COLLECTION']) {
            if (!process.env[key]?.trim() && clientSettings[key]?.trim()) process.env[key] = clientSettings[key];
        }
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const defaultOrigins = isProduction
        ? ''
        : 'http://localhost:3000,http://127.0.0.1:3000';
    const allowedOrigins = exactOrigins(process.env.CORS_ALLOWED_ORIGINS ?? defaultOrigins, 'CORS_ALLOWED_ORIGINS');
    const trustedOrigins = exactOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '', 'BETTER_AUTH_TRUSTED_ORIGINS');

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
    const userCollection = process.env.TUTORLAGBE_USER_COLLECTION?.trim() || 'user';
    if (userCollection !== 'user' && userCollection !== 'users') {
        throw new Error('TUTORLAGBE_USER_COLLECTION must be user or users.');
    }
    let auth: ReturnType<typeof createAuth> | undefined;
    let authOrigin: string | undefined;
    if (secret || authUri || process.env.BETTER_AUTH_URL) {
        const url = URL.parse(process.env.BETTER_AUTH_URL?.trim() ?? '');
        const validUrl = url && ['http:', 'https:'].includes(url.protocol) &&
            !url.hostname.includes('*') &&
            url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
        const databaseUri = authUri || mongoUri;
        if (!secret || secret.trim().length < 32 || !databaseUri || !validUrl) {
            throw new Error('Configure BETTER_AUTH_SECRET (at least 32 characters), BETTER_AUTH_URL (the exact public origin), and BETTER_AUTH_DB_URI or MONGODB_URI.');
        }

        const client = getClient(databaseUri, authUri ? 'BETTER_AUTH_DB_URI' : 'MONGODB_URI');
        if (process.env.NODE_ENV === 'production') {
            console.info('Better Auth storage configured.', {
                database: 'tutorlagbe_db', userCollection, uriSetting: authUri ? 'BETTER_AUTH_DB_URI' : 'MONGODB_URI',
            });
            console.info('Better Auth origins configured.', {
                frontendOrigin: url.origin,
                trustedOrigins: [...trustedOrigins],
            });
        }
        const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
        authOrigin = url.origin;
        auth = createAuth({
            database: mongodbAdapter(client.db('tutorlagbe_db'), { client }),
            baseURL: authOrigin,
            trustedOrigins: [...trustedOrigins],
            secret,
            userCollection,
            google: clientId && clientSecret ? { clientId, clientSecret } : undefined,
        });
    }

    const tuitionUri = mongoUri || authUri;
    const data = tuitionUri ? clients.get(tuitionUri)?.db('tutorlagbe_db') : undefined;
    const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    const billingUri = authUri || mongoUri;
    const authClient = billingUri ? clients.get(billingUri) : undefined;
    const store = authClient ? paymentStore(authClient, authClient.db('tutorlagbe_db'), userCollection) : undefined;
    let billing: BillingOptions | undefined;
    const testKeyValid = /^(sk|rk|rkcs)_test_\w+$/.test(stripeSecret ?? '');
    const webhookSecretValid = /^whsec_\w+$/.test(webhookSecret ?? '');
    if (auth && authOrigin && store && stripeSecret && webhookSecret && testKeyValid && webhookSecretValid) {
        try {
            billing = { origin: authOrigin, webhookSecret, stripe: stripeGateway(stripeSecret), store };
        } catch {
            console.warn('Stripe initialization failed. Checkout is unavailable.');
        }
    }
    if (isProduction || stripeSecret || webhookSecret) {
        const log = billing ? console.info : console.warn;
        log('Stripe test billing configuration.', {
            stripeSecretKeyPresent: Boolean(stripeSecret),
            stripeWebhookSecretPresent: Boolean(webhookSecret),
            testKeyValid,
            webhookSecretValid,
            authOriginConfigured: Boolean(authOrigin),
            paymentStoreConfigured: Boolean(store),
            paymentStoreUriSetting: authUri ? 'BETTER_AUTH_DB_URI' : mongoUri ? 'MONGODB_URI' : undefined,
            billingReady: Boolean(billing),
        });
    }
    const app = createApi({
        allowedOrigins,
        auth,
        billing,
        paymentStore: store,
        mockPayments: mockPaymentsEnabled() ? store : undefined,
        imageUploadKey: process.env.IMGBB_API_KEY?.trim(),
        tuitions: data?.collection<Tuition>('tuitions'),
        savedTuitionAccounts: authClient?.db('tutorlagbe_db').collection<SavedTuitionAccount>(userCollection),
        applications: data?.collection<Application>('applications'),
        catalog: data?.collection<CatalogChange>('catalog_changes'),
        checkAuthDatabase: auth && authClient ? async () => {
            await authClient.db('tutorlagbe_db').command({ ping: 1 }, { timeoutMS: 3000 });
        } : undefined,
        checkDatabase: async () => {
            if (!clients.size) return false;
            await Promise.all([...clients.values()].map((client) => client.db('admin').command({ ping: 1 })));
            return true;
        },
    });

    return { app, close: () => Promise.all([...clients.values()].map((client) => client.close())) };
}
