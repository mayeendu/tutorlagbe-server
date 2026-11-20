import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { z } from 'zod';

const registrationRole = z.enum(['student', 'tutor']);
export const accountRole = registrationRole.or(z.literal('admin'));
export type AccountRole = z.infer<typeof accountRole>;

interface AuthOptions {
    database: BetterAuthOptions['database'];
    baseURL: string;
    secret: string;
    google?: { clientId: string; clientSecret: string };
}

export function createAuth({ database, baseURL, secret, google }: AuthOptions) {
    return betterAuth({
        database,
        baseURL,
        secret,
        telemetry: { enabled: false },
        emailAndPassword: { enabled: true, minPasswordLength: 8 },
        user: {
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
        onAPIError: {
            onError(error) {
                if (!(error instanceof APIError) || error.status === 'INTERNAL_SERVER_ERROR') {
                    console.error('Better Auth request failed.');
                }
            },
        },
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
