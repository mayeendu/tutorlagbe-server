import { MongoError, MongoServerSelectionError } from 'mongodb';

const networkCodes = new Set(['EACCES', 'EPERM', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET']);

export function databaseErrorDetails(error: unknown) {
    if (error instanceof MongoServerSelectionError) {
        const network = new Set<string>();
        for (const server of error.reason?.servers.values() ?? []) {
            const cause = server.error?.cause;
            const code = cause && 'code' in cause ? cause.code : undefined;
            if (typeof code === 'string' && networkCodes.has(code)) network.add(code);
        }
        return { type: 'MongoServerSelectionError', network: [...network] };
    }
    if (error instanceof MongoError) {
        return { type: 'MongoError', code: typeof error.code === 'number' ? error.code : undefined };
    }
    return { type: 'UnexpectedError' };
}
