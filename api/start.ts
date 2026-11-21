import { createRuntime } from './runtime.ts';

function start() {
    const { app, close } = createRuntime();
    const port = Number(process.env.PORT ?? 8000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer from 1 to 65535.');
    }

    const host = process.env.TUTORLAGBE_API_HOST?.trim() || '0.0.0.0';
    const server = app.listen({ port, host }, () => console.info(`API listening on port ${port}`));
    server.on('error', (error: NodeJS.ErrnoException) => {
        console.error(`API could not listen on port ${port} (${error.code ?? 'unknown error'}).`);
        process.exitCode = 1;
    });

    function shutdown() {
        server.close(() => {
            void close().catch(() => {
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
