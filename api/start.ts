import 'dotenv/config';
import { MongoClient } from 'mongodb';

import { createApi } from './app.ts';

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

    const mongoUri = process.env.MONGODB_URI?.trim();
    let mongo: MongoClient | undefined;
    if (mongoUri) {
        try {
            mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000, timeoutMS: 3000 });
        } catch {
            throw new Error('MONGODB_URI is invalid.');
        }
    }

    const app = createApi({
        allowedOrigins,
        checkDatabase: async () => {
            if (!mongo) return false;
            await mongo.db('admin').command({ ping: 1 });
            return true;
        },
    });

    const server = app.listen(port, () => console.info(`API listening on port ${port}`));
    server.on('error', (error: NodeJS.ErrnoException) => {
        console.error(`API could not listen on port ${port} (${error.code ?? 'unknown error'}).`);
        process.exitCode = 1;
    });

    function shutdown() {
        server.close(() => {
            void mongo?.close().catch(() => {
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
