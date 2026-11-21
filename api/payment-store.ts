import { ObjectId, type Db, type MongoClient } from 'mongodb';

export type PaidRole = 'student' | 'tutor';
export type CheckoutAttempt = { key: string; email: string; role: PaidRole; sessionId?: string };
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
};

function owner(id: string) {
    return { _id: { $in: /^[\da-f]{24}$/i.test(id) ? [new ObjectId(id), id] : [id] } };
}

export function paymentStore(client: MongoClient, database: Db) {
    const users = database.collection<BillingUser>('user');
    const payments = database.collection<Payment>('payments');
    return {
        user: (id: string) => users.findOne(owner(id)),
        async reserve(id: string, previous: string | undefined, attempt: CheckoutAttempt) {
            const result = await users.updateOne({ ...owner(id), plan: 'free', role: attempt.role,
                'stripeCheckout.key': previous ?? { $exists: false } }, { $set: { stripeCheckout: attempt } });
            return result.modifiedCount === 1;
        },
        async saveSession(id: string, attempt: string, sessionId: string) {
            await users.updateOne({ ...owner(id), 'stripeCheckout.key': attempt }, { $set: { 'stripeCheckout.sessionId': sessionId } });
        },
        async record(payment: Payment, entitled: boolean, eventAt: number) {
            await client.withSession((session) => session.withTransaction(async () => {
                const user = await users.findOne(owner(payment.userId), { session });
                await payments.updateOne({ _id: payment._id }, { $setOnInsert: {
                    ...payment, userName: user?.name ?? payment.userName, userEmail: user?.email ?? payment.userEmail,
                } }, { upsert: true, session });
                if (!entitled || !user || user.stripeEndedSubscriptions?.includes(payment.stripeSubscriptionId)) return;
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
        latest: (offset: number, limit: number) => payments.find({}).sort({ paidAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
    };
}

export type PaymentStore = ReturnType<typeof paymentStore>;
