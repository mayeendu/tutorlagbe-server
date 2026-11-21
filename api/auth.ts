import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { MongoError } from 'mongodb';
import { z } from 'zod';

import { databaseErrorDetails } from './database-error.ts';

const registrationRole = z.enum(['student', 'tutor']);
export const accountRole = registrationRole.or(z.literal('admin'));
export type AccountRole = z.infer<typeof accountRole>;

interface AuthOptions {
    database: BetterAuthOptions['database'];
    baseURL: string;
    trustedOrigins?: string[];
    secret: string;
    userCollection?: 'user' | 'users';
    google?: { clientId: string; clientSecret: string };
}

export function createAuth({ database, baseURL, secret, google, userCollection, trustedOrigins }: AuthOptions) {
    return betterAuth({
        database,
        baseURL,
        trustedOrigins,
        secret,
        telemetry: { enabled: false },
        logger: {
            level: 'warn',
            log(level, _message, ...details: unknown[]) {
                const report = level === 'error' ? console.error : console.warn;
                const databaseError = details.find((detail) => detail instanceof MongoError);
                if (databaseError) report('Better Auth database operation failed.', databaseErrorDetails(databaseError));
                else report('Better Auth reported an issue.');
            },
        },
        emailAndPassword: { enabled: true, minPasswordLength: 8 },
        user: {
            modelName: userCollection,
            additionalFields: {
                role: { type: 'string', defaultValue: 'student', validator: { input: registrationRole } },
                plan: { type: 'string', defaultValue: 'free', input: false },
                phone: { type: 'string', required: false, input: false },
                bio: { type: 'string', required: false, input: false },
            },
        },
        hooks: {
            before: createAuthMiddleware(async (context) => {
                if (context.path === '/update-user' && context.body?.role !== undefined) {
                    throw new APIError('BAD_REQUEST', { message: 'Role changes require an administrator.' });
                }
            }),
        },
        socialProviders: google ? { google } : {},
        onAPIError: { throw: true },
        plugins: [jwt({
            disableSettingJwtHeader: true,
            jwt: {
                issuer: baseURL,
                audience: 'tutorlagbe-api',
                expirationTime: '5m',
                definePayload: ({ session }) => ({ sid: session.id }),
            },
        })],
    });
}

export type TutorAuth = ReturnType<typeof createAuth>;
