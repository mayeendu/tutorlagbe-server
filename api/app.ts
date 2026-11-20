import express from 'express';

interface ApiOptions {
    allowedOrigins: ReadonlySet<string>;
    checkDatabase: () => Promise<boolean>;
}

export function createApi({ allowedOrigins, checkDatabase }: ApiOptions) {
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

    app.use((_request, response) => {
        response.status(404).json({ error: 'Route not found' });
    });

    return app;
}
