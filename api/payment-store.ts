import { MongoServerError, ObjectId, type ClientSession, type Db, type MongoClient } from 'mongodb';

export type PaidRole = 'student' | 'tutor';
export type MockPlan = 'plus' | 'pro';
type MockPurchase = { role: PaidRole; amount: number; paidAt: Date };
type MockPayment = Pick<Payment, '_id' | 'userId' | 'userRole' | 'userName' | 'userEmail' | 'currency' | 'amount' | 'paidAt'> & {
    provider: 'mock'; status: 'paid'; plan: MockPlan; planName: 'Plus' | 'Pro'; createdAt: Date; updatedAt: Date;
};
export type CheckoutAttempt = { key: string; email: string; role: PaidRole; sessionId?: string; kind?: 'one-time' };
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
export type CheckoutPayment = Omit<Payment, 'stripeSubscriptionId' | 'transactionId' | 'paymentStatus' | 'paidAt'> & {
    kind: 'one-time';
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
    mockPurchases?: Partial<Record<MockPlan, MockPurchase>>;
};

function owner(id: string) {
    return { _id: { $in: /^[\da-f]{24}$/i.test(id) ? [new ObjectId(id), id] : [id] } };
}

export function paymentStore(client: MongoClient, database: Db, userCollection: 'user' | 'users' = 'user') {
    const users = database.collection<BillingUser>(userCollection);
    const payments = database.collection<Payment | CheckoutPayment | MockPayment>('payments');
    let checkoutIndex: Promise<string> | undefined;

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
            const result = await users.updateOne({ ...owner(id), plan: { $in: ['free', 'plus'] }, role: attempt.role,
                'stripeCheckout.key': previous ?? { $exists: false } }, { $set: { stripeCheckout: attempt } });
            return result.modifiedCount === 1;
        },
        async saveSession(id: string, attempt: string, sessionId: string) {
            await users.updateOne({ ...owner(id), 'stripeCheckout.key': attempt }, { $set: { 'stripeCheckout.sessionId': sessionId } });
        },
        mockCheckout(id: string, role: PaidRole, plan: MockPlan, amount: number) {
            const purchaseKey = `mockPurchases.${plan}`;
            const account = { ...owner(id), role };
            return transactionWhenAvailable(async (session) => {
                const paidAt = new Date();
                const user = await users.findOneAndUpdate({
                    ...account, plan: { $in: plan === 'plus' ? ['free'] : ['free', 'plus'] },
                    [purchaseKey]: { $exists: false },
                }, { $set: { plan, [purchaseKey]: { role, amount, paidAt }, updatedAt: paidAt } },
                { returnDocument: 'after', session }) ?? await users.findOne(account, { session });
                const purchase = user?.mockPurchases?.[plan];
                if (!user || !purchase) return null;

                const payment: MockPayment = {
                    _id: `mock:${id}:${plan}`, userId: id, userRole: purchase.role, userName: user.name,
                    userEmail: user.email, plan, planName: plan === 'plus' ? 'Plus' : 'Pro', provider: 'mock', status: 'paid',
                    amount: purchase.amount, currency: 'usd', paidAt: purchase.paidAt,
                    createdAt: purchase.paidAt, updatedAt: purchase.paidAt,
                };
                await payments.updateOne({ _id: payment._id }, { $setOnInsert: payment }, { upsert: true, session });
                return { plan: payment.plan, paymentId: payment._id };
            });
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
                await users.updateOne({ ...owner(id), stripeSubscriptionId: subscriptionId,
                    $or: [{ stripeEventAt: { $exists: false } }, { stripeEventAt: { $lte: eventAt } }],
                }, { $set: { plan: 'free', stripeEventAt: eventAt } }, { session });
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
                userRole: payment.userRole, amount: payment.amount, currency: payment.currency };
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
                await users.updateOne({ _id: user._id, role: payment.userRole,
                    $or: [{ proPaymentSessionId: { $exists: false } }, { proPaymentSessionId: payment.stripeSessionId }],
                }, { $set: { plan: 'pro', proPaymentSessionId: payment.stripeSessionId },
                    $unset: { stripeSubscriptionId: '' } }, { session });
            });
        },
        latest: (offset: number, limit: number) => payments.find({
            $or: [{ status: 'paid' }, { paymentStatus: 'paid' }],
        }).sort({ paidAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
        history: (userId: string, offset: number, limit: number) => payments.aggregate([
            { $match: { userId } },
            { $addFields: { date: { $ifNull: ['$createdAt', '$paidAt'] }, status: { $ifNull: ['$status', '$paymentStatus'] } } },
            { $sort: { date: -1, _id: -1 } }, { $skip: offset }, { $limit: limit },
            { $project: { date: 1, status: 1, amount: 1, currency: 1, planName: 1, stripeSessionId: 1, transactionId: 1 } },
        ]).toArray(),
    };
}

export type PaymentStore = ReturnType<typeof paymentStore>;
