import { Router, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { verifyToken } from '../access.ts';
import type { TutorAuth } from '../auth.ts';

const maxBytes = 3 * 1024 * 1024;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes + 1, files: 1, fields: 0 },
});

function imageFormat(bytes: Buffer) {
    if (bytes.subarray(0, 8).equals(pngSignature)) return { mime: 'image/png', extension: 'png' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mime: 'image/jpeg', extension: 'jpg' };
    }
    if (bytes.length >= 16 && bytes.toString('utf8', 0, 4) === 'RIFF' &&
        bytes.toString('utf8', 8, 12) === 'WEBP' &&
        ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('utf8', 12, 16))) {
        return { mime: 'image/webp', extension: 'webp' };
    }
}

export const hostedImageUrl = z.url({ protocol: /^https$/, hostname: /^i\.ibb\.co$/ }).max(2048);
const imgBBResponse = z.object({ success: z.literal(true), data: z.object({ url: hostedImageUrl }) });

export function uploadRoutes(auth: TutorAuth, apiKey?: string) {
    const router = Router();
    router.use(verifyToken(auth));
    if (!apiKey) {
        router.post('/', (_request, response) => {
            response.status(503).json({ error: 'Image uploads are not configured.' });
        });
        return router;
    }

    router.post('/', (request, response, next) => {
        if (!request.is('multipart/form-data')) {
            response.status(415).json({ error: 'Send one image as multipart form data.' });
            return;
        }
        next();
    }, upload.single('image'), async (request, response) => {
        const file = request.file;
        if (!file) {
            response.status(400).json({ error: 'Choose an image to upload.' });
            return;
        }
        if (file.size > maxBytes) {
            response.status(413).json({ error: 'The image must be 3 MB or smaller.' });
            return;
        }
        const format = imageFormat(file.buffer);
        if (!format) {
            response.status(415).json({ error: 'Choose a JPEG, PNG, or WebP image.' });
            return;
        }

        const target = new URL('https://api.imgbb.com/1/upload');
        target.searchParams.set('key', apiKey);
        const data = new FormData();
        data.set('image', new Blob([new Uint8Array(file.buffer)], { type: format.mime }), 'image.' + format.extension);

        try {
            const upstream = await fetch(target, {
                method: 'POST', body: data, redirect: 'error', signal: AbortSignal.timeout(15000),
            });
            const result = imgBBResponse.safeParse(await upstream.json());
            if (upstream.ok && result.success) {
                response.status(201).json({ imageUrl: result.data.data.url });
                return;
            }
        } catch {
            // Keep provider details and credentials out of the response.
        }
        response.status(502).json({ error: 'Image hosting is temporarily unavailable. Try again.' });
    });

    const handleError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            response.status(413).json({ error: 'The image must be 3 MB or smaller.' });
            return;
        }
        response.status(400).json({ error: 'Send one image in the image field.' });
    };
    router.use(handleError);
    return router;
}
