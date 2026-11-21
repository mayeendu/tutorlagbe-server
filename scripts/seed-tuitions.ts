import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { MongoClient, ObjectId } from 'mongodb';

import { tuitionInput, type Tuition } from '../api/tuitions.ts';

const tutors = [
    { key: 'farhana', name: 'Farhana Rahman', bio: 'I teach school mathematics and physics using worked examples, short quizzes, and Bangla explanations.', courses: [
        ['SSC General Mathematics Practice', 'Mathematics', 'Class 9–10', 'Offline', 'Dhanmondi, Dhaka', 2600, 3, 'Build confidence with algebra, geometry, and board question sets. Each session ends with a short practice review.'],
        ['HSC Physics Problem Lab', 'Physics', 'Class 11–12', 'Online', '', 3200, 3, 'Work through mechanics and electricity problems with annotated examples and a weekly timed problem set.'],
    ] },
    { key: 'tanvir', name: 'Tanvir Hasan', bio: 'I help secondary and higher-secondary students strengthen science fundamentals and prepare for board exams.', courses: [
        ['Chemical Reactions and Calculations', 'Chemistry', 'Class 9–10', 'Offline', 'Mirpur, Dhaka', 2400, 3, 'Practice balancing equations, mole calculations, and reaction patterns with short written checks after each topic.'],
        ['HSC Biology Chapter Review', 'Biology', 'Class 11–12', 'Online', '', 2900, 2, 'Review cell biology, genetics, and physiology with diagram practice and structured board-style questions.'],
    ] },
    { key: 'nabila', name: 'Nabila Ahmed', bio: 'I coach students in academic writing, speaking, and exam preparation through individual feedback.', courses: [
        ['IELTS Speaking and Writing Workshop', 'IELTS', 'Test preparation', 'Online', '', 3800, 3, 'Complete timed speaking prompts and Task 2 essays, then receive feedback on coherence and vocabulary.'],
        ['English Grammar and Paragraph Writing', 'English', 'Class 6–8', 'Offline', 'Uttara, Dhaka', 2200, 2, 'Improve sentence structure and paragraph organization through guided writing tasks and weekly revisions.'],
    ] },
    { key: 'sadia', name: 'Sadia Islam', bio: 'I tutor business studies and economics with practical examples and step-by-step exam preparation.', courses: [
        ['HSC Accounting Fundamentals', 'Accounting', 'Class 11–12', 'Offline', 'Agrabad, Chattogram', 3000, 3, 'Learn journal entries, ledgers, and trial balances by completing a small business case from start to finish.'],
        ['Economics with Local Examples', 'Economics', 'Class 11–12', 'Online', '', 2700, 2, 'Study demand, supply, and inflation using Bangladesh examples and practice drawing and interpreting graphs.'],
    ] },
    { key: 'arif', name: 'Arif Hossain', bio: 'I teach computing through short exercises and small projects that students complete independently.', courses: [
        ['HSC ICT and Practical Skills', 'ICT', 'Class 11–12', 'Offline', 'Boalia, Rajshahi', 2500, 2, 'Practice number systems, HTML, and database concepts alongside the practical tasks used in class.'],
        ['Python for First-Time Programmers', 'Programming', 'Beginner', 'Online', '', 3500, 3, 'Learn variables, loops, and functions by building a quiz and a simple expense tracker.'],
    ] },
    { key: 'nusrat', name: 'Nusrat Jahan', bio: 'I help middle-school students improve Bangla writing and develop clear revision habits in social science.', courses: [
        ['Bangla Reading and Composition', 'Bangla', 'Class 6–8', 'Offline', 'Zindabazar, Sylhet', 2100, 2, 'Read short prose passages and practice summaries, formal letters, and composition with feedback.'],
        ['Bangladesh and Global Studies Review', 'Social Studies', 'Class 8–10', 'Online', '', 2300, 2, 'Connect the syllabus to maps, timelines, and civic examples, then practice structured answers before exams.'],
    ] },
] as const;

function readSettings(paths: string[]) {
    return Object.assign({}, ...paths.map((path) => {
        const file = new URL(path, import.meta.url);
        return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
    })) as Record<string, string>;
}

function seedId(key: string) {
    return new ObjectId(createHash('sha256').update(`tutorlagbe:initial-catalog:v1:${key}`).digest('hex').slice(0, 24));
}

async function main() {
    // Validate the complete catalog before making any writes.
    const catalog = tutors.map(({ courses, ...tutor }) => ({
        ...tutor, courses: courses.map(([title, subject, classLevel, mode, location, monthlyFee, daysPerWeek, description]) =>
            tuitionInput.parse({ title, subject, classLevel, mode, location, monthlyFee, daysPerWeek, description })),
    }));
    if (process.argv.includes('--validate')) {
        console.info(`Validated ${catalog.flatMap((tutor) => tutor.courses).length} initial tuition listings.`);
        return;
    }

    const server = readSettings(['../.env']);
    const web = readSettings(['.env', '.env.development', '.env.local', '.env.development.local']
        .map((name) => `../../tutorlagbe-client/${name}`));
    const mongoUri = (process.env.MONGODB_URI ?? server.MONGODB_URI)?.trim();
    const authUri = (process.env.BETTER_AUTH_DB_URI ?? server.BETTER_AUTH_DB_URI)?.trim() || mongoUri || web.BETTER_AUTH_DB_URI?.trim();
    if (!authUri) throw new Error('Configure BETTER_AUTH_DB_URI or MONGODB_URI before running the seed.');
    const userCollection = (process.env.TUTORLAGBE_USER_COLLECTION ?? server.TUTORLAGBE_USER_COLLECTION ??
        web.TUTORLAGBE_USER_COLLECTION) === 'users' ? 'users' : 'user';
    const authClient = new MongoClient(authUri, { serverSelectionTimeoutMS: 4000 });
    const tuitionClient = !mongoUri || mongoUri === authUri ? authClient : new MongoClient(mongoUri, { serverSelectionTimeoutMS: 4000 });

    try {
        const users = authClient.db('tutorlagbe_db').collection(userCollection);
        const tuitions = tuitionClient.db('tutorlagbe_db').collection<Tuition>('tuitions');
        const tutorIds = new Set((await users.find({ role: 'tutor' }, { projection: { _id: 1 } }).toArray()).map(({ _id }) => String(_id)));
        const approved = (await tuitions.find({ approvalStatus: 'approved', isActive: true },
            { projection: { tutorId: 1, subject: 1 } }).toArray()).filter((listing) => tutorIds.has(listing.tutorId));
        const subjects = new Set(approved.map(({ subject }) => subject.trim().toLowerCase())).size;
        console.info(`Existing catalog: ${approved.length} approved, active tuitions linked to tutor accounts across ${subjects} subjects.`);
        if (approved.length >= 12 && subjects >= 8) return;
        if (process.argv.includes('--check')) {
            process.exitCode = 1;
            return;
        }

        const now = new Date();
        let inserted = 0;
        for (const tutor of catalog) {
            const tutorId = seedId(`tutor:${tutor.key}`);
            const tutorEmail = `seed.${tutor.key}@tutorlagbe.example`;
            await users.updateOne({ _id: tutorId }, { $setOnInsert: {
                name: tutor.name, email: tutorEmail, emailVerified: false, role: 'tutor', plan: 'free',
                bio: tutor.bio, createdAt: now, updatedAt: now,
            } }, { upsert: true });
            const owner = await users.findOne({ _id: tutorId, role: 'tutor', email: tutorEmail });
            if (!owner) throw new Error('A seed tutor ID conflicts with an existing account.');

            for (const [index, course] of tutor.courses.entries()) {
                const result = await tuitions.updateOne({ _id: seedId(`tuition:${tutor.key}:${index}`) }, { $setOnInsert: {
                    ...course, tutorId: tutorId.toHexString(), tutorName: String(owner.name), tutorEmail,
                    approvalStatus: 'approved', isActive: true, revision: 1, createdAt: now,
                } }, { upsert: true });
                inserted += result.upsertedCount;
            }
        }
        console.info(`Inserted ${inserted} initial tuition listings.`);
    } catch {
        throw new Error('Could not verify or seed the catalog. Check MongoDB access and seed record conflicts.');
    } finally {
        await Promise.all([authClient.close(), ...(tuitionClient === authClient ? [] : [tuitionClient.close()])]);
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not seed the catalog.');
    process.exitCode = 1;
}
