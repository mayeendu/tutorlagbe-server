import 'dotenv/config';
import express, {
    type Express,
    type Request,
    type Response
} from 'express';
import { MongoClient } from 'mongodb';
import uploadRoutes from './routes/upload.routes.js';

const app: Express = express();
const PORT = Number(process.env.PORT) || 8000;

const { DB_USER, DB_PASSWORD } = process.env;

if (!DB_USER || !DB_PASSWORD) {
    throw new Error('Missing MongoDB environment variables');
}

const mongoURI = `mongodb://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@ac-tt3qdep-shard-00-00.0evpyqx.mongodb.net:27017,ac-tt3qdep-shard-00-01.0evpyqx.mongodb.net:27017,ac-tt3qdep-shard-00-02.0evpyqx.mongodb.net:27017/?ssl=true&replicaSet=atlas-znj91g-shard-0&authSource=admin`;

const client = new MongoClient(mongoURI);

// Middleware
app.use(express.json());

// Health check
app.get('/', (_req: Request, res: Response) => {
    res.send('TutorLagbe server is running successfully!');
});

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
});

// API routes
app.use('/upload', uploadRoutes);

// Keep any other existing routes here.

export async function connectToMongoDB() {
    await client.connect();
    console.log('MongoDB connected successfully!');
    return client;
}

export async function disconnectFromMongoDB() {
    await client.close();
}

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
        status: 'ok',
        message: 'TutorLagbe backend is running',
        timestamp: new Date().toISOString(),
    });
});

async function startServer() {
    try {
        await connectToMongoDB();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Server startup failed:', error);
        process.exitCode = 1;
        await client.close();
    }
}

void startServer();

export default app;