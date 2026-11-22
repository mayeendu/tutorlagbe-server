import { randomUUID } from 'node:crypto';
import { MongoServerError, ObjectId, type ClientSession, type Db, type MongoClient } from 'mongodb';

export type PaidRole = 'student' | 'tutor';
export type PaidPlan = 'plus' | 'pro';
export type MockPlan = PaidPlan;
type MockPayment = Pick<Payment, '_id' | 'userId' | 'userRole' | 'userName' | 'userEmail' | 'currency' | 'amount' | 'paidAt'> & {
    provider: 'mock'; status: 'paid'; plan: MockPlan; planName: 'Plus' | 'Pro'; createdAt: Date; updatedAt: Date;
};
export type MockOutcome = 'paid' | 'failed' | 'cancelled';
type MockSession = Omit<MockPayment, 'paidAt' | 'status'> & {
    kind: 'demo-checkout';
    status: 'pending' | 'expired' | MockOutcome;
    checkoutExpiresAt: Date;
    entitlementExpiresAt?: Date;
    paidAt?: Date;
    activeSlot?: string;
};
export type CheckoutAttempt = { key: string; email: string; role: PaidRole; sessionId?: string; kind?: 'one-time'; plan?: PaidPlan };
export type Payment = {
    _id: string;
    userId: string;
    userRole: PaidRole;
    userName: string;
    userEmail: string;
    planName: 'Pro';
    amount: number;
    currency: 'usd';
    stripeSessionId: string;
    stripeSubscriptionId: string;
    transactionId: string;
    paymentStatus: 'paid';
    paidAt: Date;
};
export type CheckoutPayment = Omit<Payment, 'stripeSubscriptionId' | 'transactionId' | 'paymentStatus' | 'paidAt' | 'planName'> & {
    kind: 'one-time';
    planName: 'Plus' | 'Pro';
    status: 'pending' | 'paid' | 'failed' | 'expired';
    transactionId?: string;
    stripeCustomerId?: string;
    stripeEventId?: string;
    createdAt: Date;
    updatedAt: Date;
    paidAt?: Date;
    eventAt?: number;
};

type BillingUser = {
    _id: ObjectId | string;
    name: string;
    email: string;
    role: string;
    plan: string;
    stripeCheckout?: CheckoutAttempt;
    stripeSubscriptionId?: string;
    stripeEndedSubscriptions?: string[];
    stripeEventAt?: number;
    proPaymentSessionId?: string;
    plusPaymentSessionId?: string;
};

function owner(id: string) {
    return { _id: { $in: /^[\da-f]{24}$/i.test(id) ? [new ObjectId(id), id] : [id] } };
}

export function paymentStore(client: MongoClient, database: Db, userCollection: 'user' | 'users' = 'user') {
    const users = database.collection<BillingUser>(userCollection);
    const payments = database.collection<Payment | CheckoutPayment | MockPayment | MockSession>('payments');
    let checkoutIndex: Promise<string> | undefined;
    let demoIndex: Promise<string> | undefined;
    const demo = { kind: 'demo-checkout' as const, provider: 'mock' as const };
    const day = 86_400_000;

    async function transactionWhenAvailable<T>(write: (session?: ClientSession) => Promise<T>) {
        try {
            return await client.withSession((session) => session.withTransaction(() => write(session)));
        } catch (error) {
            if (!(error instanceof MongoServerError) || error.code !== 20 ||
                !error.message.includes('Transaction numbers are only allowed')) throw error;
            return write();
        }
    }
    return {
        user: (id: string) => users.findOne(owner(id)),
        async reserve(id: string, previous: string | undefined, attempt: CheckoutAttempt) {
            const result = await users.updateOne({ ...owner(id), plan: { $in: attempt.plan === 'plus' ? ['free'] : ['free', 'plus'] }, role: attempt.role,
                'stripeCheckout.key': previous ?? { $exists: false } }, { $set: { stripeCheckout: attempt } });
            return result.modifiedCount === 1;
        },
        async saveSession(id: string, attempt: string, sessionId: string) {
            await users.updateOne({ ...owner(id), 'stripeCheckout.key': attempt }, { $set: { 'stripeCheckout.sessionId': sessionId } });
        },
        async createMockSession(userId: string, role: PaidRole, plan: MockPlan, amount: number) {
            const user = await users.findOne({ ...owner(userId), role });
            if (!user) return null;
            demoIndex ??= payments.createIndex({ activeSlot: 1 }, {
                name: 'active_demo_checkout', unique: true, partialFilterExpression: { activeSlot: { $type: 'string' } },
            }).catch((error: unknown) => { demoIndex = undefined; throw error; });
            await demoIndex;
            const now = new Date();
            const activeSlot = `${userId}:${plan}`;
            await payments.updateOne({ ...demo, activeSlot, status: 'pending', checkoutExpiresAt: { $lte: now } },
                { $set: { status: 'expired', updatedAt: now }, $unset: { activeSlot: '' } });
            await payments.updateOne({ ...demo, activeSlot, status: 'paid', entitlementExpiresAt: { $lte: now } },
                { $unset: { activeSlot: '' } });
            const payment: MockSession = {
                ...demo, _id: `mock_${randomUUID()}`, userId, userRole: role, userName: user.name, userEmail: user.email,
                plan, planName: plan === 'plus' ? 'Plus' : 'Pro', amount, currency: 'usd', status: 'pending', activeSlot,
                checkoutExpiresAt: new Date(now.getTime() + 30 * 60_000), createdAt: now, updatedAt: now,
            };
            try {
                await payments.insertOne(payment);
                return payment;
            } catch (error) {
                if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
                return payments.findOne<MockSession>({ ...demo, userId, userRole: role, activeSlot, status: 'pending' });
            }
        },
        async mockSession(id: string, userId: string, role: PaidRole) {
            const filter = { ...demo, _id: id, userId, userRole: role };
            const payment = await payments.findOne<MockSession>(filter);
            return payment?.status === 'pending' && payment.checkoutExpiresAt <= new Date()
                ? { ...payment, status: 'expired' as const }
                : payment;
        },
        async settleMockSession(id: string, userId: string, role: PaidRole, outcome: MockOutcome) {
            const now = new Date();
            const filter = { ...demo, _id: id, userId, userRole: role };
            await payments.updateOne({ ...filter, status: 'pending', checkoutExpiresAt: { $lte: now } },
                { $set: { status: 'expired', updatedAt: now }, $unset: { activeSlot: '' } });
            const finalized = await payments.findOneAndUpdate({ ...filter, status: 'pending', checkoutExpiresAt: { $gt: now } },
                outcome === 'paid'
                    ? { $set: { status: outcome, updatedAt: now, paidAt: now, entitlementExpiresAt: new Date(now.getTime() + 30 * day) } }
                    : { $set: { status: outcome, updatedAt: now }, $unset: { activeSlot: '' } },
                { returnDocument: 'after' });
            return (finalized as MockSession | null) ?? await payments.findOne<MockSession>(filter);
        },
        async mockEntitlement(userId: string, role: PaidRole) {
            const paid = { ...demo, userId, userRole: role, status: 'paid' as const, entitlementExpiresAt: { $gt: new Date() } };
            for (const plan of ['pro', 'plus'] as const) {
                const record = await payments.findOne<MockSession>({ ...paid, plan }, { sort: { entitlementExpiresAt: -1 } });
                if (record?.entitlementExpiresAt) return { plan, expiresAt: record.entitlementExpiresAt };
            }
            return null;
        },
        async record(payment: Payment, entitled: boolean, eventAt: number) {
            await client.withSession((session) => session.withTransaction(async () => {
                const user = await users.findOne(owner(payment.userId), { session });
                await payments.updateOne({ _id: payment._id }, { $setOnInsert: {
                    ...payment, userName: user?.name ?? payment.userName, userEmail: user?.email ?? payment.userEmail,
                } }, { upsert: true, session });
                if (!entitled || !user || user.proPaymentSessionId || user.stripeEndedSubscriptions?.includes(payment.stripeSubscriptionId)) return;
                if ((user.stripeEventAt ?? 0) > eventAt ||
                    (user.stripeSubscriptionId && user.stripeSubscriptionId !== payment.stripeSubscriptionId && user.plan === 'pro')) return;
                await users.updateOne({ _id: user._id }, { $set: {
                    plan: 'pro', stripeSubscriptionId: payment.stripeSubscriptionId, stripeEventAt: eventAt,
                } }, { session });
            }));
        },
        async revoke(id: string, subscriptionId: string, eventAt: number, ended: boolean) {
            await client.withSession((session) => session.withTransaction(async () => {
                if (ended) await users.updateOne(owner(id), { $addToSet: { stripeEndedSubscriptions: subscriptionId } }, { session });
                await users.updateOne({ ...owner(id), stripeSubscriptionId: subscriptionId, plan: 'pro',
                    $or: [{ stripeEventAt: { $exists: false } }, { stripeEventAt: { $lte: eventAt } }],
                }, [{ $set: { plan: { $cond: ['$plusPaymentSessionId', 'plus', 'free'] }, stripeEventAt: eventAt } }], { session });
            }));
        },
        async savePending(payment: CheckoutPayment) {
            checkoutIndex ??= payments.createIndex({ stripeSessionId: 1 }, {
                name: 'one_time_stripe_session', unique: true, partialFilterExpression: { kind: 'one-time' },
            }).catch((error: unknown) => { checkoutIndex = undefined; throw error; });
            await checkoutIndex;
            await payments.updateOne({ _id: payment._id }, { $setOnInsert: payment }, { upsert: true });
        },
        checkoutPayment: (sessionId: string, userId: string) => payments.findOne<CheckoutPayment>({ _id: sessionId, kind: 'one-time', userId }),
        async settleCheckout(payment: CheckoutPayment, eventAt: number) {
            const { status, stripeEventId, transactionId, stripeCustomerId, paidAt } = payment;
            const identity = { _id: payment._id, kind: 'one-time' as const, userId: payment.userId,
                userRole: payment.userRole, amount: payment.amount, currency: payment.currency, planName: payment.planName };
            const identifiers = { ...(transactionId ? { transactionId } : {}), ...(stripeCustomerId ? { stripeCustomerId } : {}) };
            const update = { status, stripeEventId, eventAt, updatedAt: payment.updatedAt, ...identifiers, ...(paidAt ? { paidAt } : {}) };

            if (status !== 'paid') {
                await payments.updateOne({ ...identity, status: { $ne: 'paid' },
                    $or: [{ eventAt: { $exists: false } }, { eventAt: { $lte: eventAt } }],
                }, { $set: update });
                return;
            }
            await transactionWhenAvailable(async (session) => {
                const user = await users.findOne({ ...owner(payment.userId), role: payment.userRole }, { session });
                if (!user) return;
                await payments.updateOne({ ...identity, status: { $ne: 'paid' } }, { $set: update }, { session });
                const settled = await payments.findOne({ ...identity, status: 'paid' }, { session });
                if (!settled) return;
                if (payment.planName === 'Plus') {
                    await users.updateOne({ _id: user._id, role: payment.userRole,
                        plusPaymentSessionId: { $exists: false },
                    }, [{ $set: { plan: { $cond: [{ $eq: ['$plan', 'pro'] }, 'pro', 'plus'] },
                        plusPaymentSessionId: payment.stripeSessionId } }], { session });
                } else {
                    await users.updateOne({ _id: user._id, role: payment.userRole, proPaymentSessionId: { $exists: false } },
                        { $set: { plan: 'pro', proPaymentSessionId: payment.stripeSessionId },
                            $unset: { stripeSubscriptionId: '' } }, { session });
                }
            });
        },
        latest: (offset: number, limit: number) => payments.find({
            provider: { $ne: 'mock' },
            $or: [{ status: 'paid' }, { paymentStatus: 'paid' }],
        }).sort({ paidAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
        history: (userId: string, offset: number, limit: number, includeMock = false) => payments.aggregate([
            { $match: includeMock ? { userId } : { userId, provider: { $ne: 'mock' } } },
            { $addFields: { date: { $ifNull: ['$createdAt', '$paidAt'] }, status: { $ifNull: ['$status', '$paymentStatus'] } } },
            { $sort: { date: -1, _id: -1 } }, { $skip: offset }, { $limit: limit },
            { $project: { date: 1, status: 1, amount: 1, currency: 1, planName: 1, provider: 1, stripeSessionId: 1, transactionId: 1 } },
        ]).toArray(),
    };
}

export type PaymentStore = ReturnType<typeof paymentStore>;
