import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const metadata = z.record(z.string(), z.string()).optional();
export const checkoutSchema = z.object({
    id: z.string().regex(/^cs_[\w]+$/), status: z.enum(['open', 'complete', 'expired']),
    url: z.url().nullable(), subscription: z.string().nullable(), metadata,
    livemode: z.boolean().optional(), mode: z.string().optional(),
    client_reference_id: z.string().nullable().optional(),
    amount_total: z.number().int().nonnegative().nullable().optional(),
    currency: z.string().nullable().optional(), payment_status: z.string().optional(),
    payment_intent: z.string().nullable().optional(), customer: z.string().nullable().optional(),
});
export const subscriptionSchema = z.object({ id: z.string().regex(/^sub_[\w]+$/), status: z.string(), customer: z.string(),
    latest_invoice: z.string().nullable().optional(), metadata });
export const invoiceSchema = z.object({
    id: z.string().regex(/^in_[\w]+$/), status: z.string(), amount_paid: z.number().int().nonnegative(), currency: z.string(),
    payment_intent: z.string().nullable().optional(), subscription: z.string().nullable().optional(),
    customer_name: z.string().nullable().optional(), customer_email: z.string().nullable().optional(),
    parent: z.object({ subscription_details: z.object({ subscription: z.string() }).nullable().optional() }).nullable().optional(),
    status_transitions: z.object({ paid_at: z.number().int().positive().nullable() }).optional(),
});
export const stripeEventSchema = z.object({
    id: z.string().regex(/^evt_\w+$/), livemode: z.boolean(), type: z.string(), created: z.number().int().positive(),
    data: z.object({ object: z.object({ id: z.string(), metadata }) }),
});

export function validStripeSignature(body: Buffer, header: string, secret: string, now = Date.now()) {
    const parts = header.split(',').map((part) => part.trim().split('='));
    const timestamps = parts.filter(([name]) => name === 't');
    const timestamp = timestamps[0]?.[1];
    if (timestamps.length !== 1 || !timestamp || !/^\d{1,13}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
    return parts.some(([name, signature]) => name === 'v1' && /^[0-9a-f]{64}$/i.test(signature ?? '') &&
        timingSafeEqual(digest, Buffer.from(signature!, 'hex')));
}

export function stripeGateway(secret: string) {
    async function request<T>(path: string, schema: z.ZodType<T>, form?: URLSearchParams, key?: string) {
        const response = await fetch(`https://api.stripe.com/v1/${path}`, {
            method: form ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': '2024-06-20',
                ...(key ? { 'Idempotency-Key': key } : {}) },
            body: form, redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Stripe request failed.');
        return schema.parse(await response.json());
    }

    return {
        createCheckout: (form: URLSearchParams, key: string) => request('checkout/sessions', checkoutSchema, form, key),
        checkout: (id: string) => request(`checkout/sessions/${encodeURIComponent(id)}`, checkoutSchema),
        invoice: (id: string) => request(`invoices/${encodeURIComponent(id)}`, invoiceSchema),
        subscription: (id: string) => request(`subscriptions/${encodeURIComponent(id)}`, subscriptionSchema),
        portal: (customer: string, returnUrl: string) => request('billing_portal/sessions', z.object({ url: z.url() }), new URLSearchParams({ customer, return_url: returnUrl })),
        async checkoutForSubscription(id: string) {
            const query = new URLSearchParams({ subscription: id, limit: '1' });
            const result = await request(`checkout/sessions?${query}`, z.object({ data: z.array(checkoutSchema) }));
            return result.data[0];
        },
    };
}

export type StripeGateway = ReturnType<typeof stripeGateway>;
