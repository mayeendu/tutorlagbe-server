import type { RequestHandler } from 'express';
import { z } from 'zod';

import { accountRole, type AccountRole, type TutorAuth } from './auth.ts';

const claimsSchema = z.object({ sub: z.string().min(1), sid: z.string().min(1) });
const identitySchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.email(),
    role: accountRole,
    plan: z.enum(['free', 'plus', 'pro']),
});
export type AuthIdentity = z.infer<typeof identitySchema>;

export function verifyToken(auth: TutorAuth): RequestHandler {
    return async (request, response, next) => {
        response.set('Cache-Control', 'no-store');
        const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i
            .exec(request.get('Authorization') ?? '')?.[1];
        const reject = () => response.set('WWW-Authenticate', 'Bearer')
            .status(401).json({ error: 'Authentication required' });

        if (!token || token.length > 4096) {
            reject();
            return;
        }

        try {
            const { payload } = await auth.api.verifyJWT({ body: { token } });
            const claims = claimsSchema.safeParse(payload);
            if (!claims.success) {
                reject();
                return;
            }

            const { adapter, internalAdapter } = await auth.$context;
            const session = await adapter.findOne<{ userId: string; expiresAt: Date }>({
                model: 'session',
                where: [{ field: 'id', value: claims.data.sid }],
            });
            if (!session || session.userId !== claims.data.sub || !(session.expiresAt > new Date())) {
                reject();
                return;
            }

            const user = await internalAdapter.findUserById(claims.data.sub);
            if (!user) {
                reject();
                return;
            }

            const identity = identitySchema.safeParse(user);
            if (!identity.success) {
                response.status(403).json({ error: 'Account permissions are unavailable' });
                return;
            }

            response.locals.identity = identity.data;
            next();
        } catch {
            response.status(503).json({ error: 'Authentication is temporarily unavailable' });
        }
    };
}

function requireRole(role: AccountRole): RequestHandler {
    return (_request, response, next) => {
        const identity = identitySchema.safeParse(response.locals.identity);
        if (!identity.success) {
            response.status(401).json({ error: 'Authentication required' });
            return;
        }
        if (identity.data.role !== role) {
            response.status(403).json({ error: 'Access denied' });
            return;
        }
        next();
    };
}

export const verifyStudent = requireRole('student');
export const verifyTutor = requireRole('tutor');
export const verifyAdmin = requireRole('admin');
