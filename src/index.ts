import express, { type Express, type Request, type Response } from 'express';
import 'dotenv/config'
import { MongoClient } from 'mongodb';
import uploadRoutes from './routes/upload.routes';

const app: Express = express();
const port = 8000;

const app: Express = express();
const port = 8000;

const mongoURI = `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-tt3qdep-shard-00-00.0evpyqx.mongodb.net:27017,ac-tt3qdep-shard-00-01.0evpyqx.mongodb.net:27017,ac-tt3qdep-shard-00-02.0evpyqx.mongodb.net:27017/?ssl=true&replicaSet=atlas-znj91g-shard-0&authSource=admin`;

const client = new MongoClient(mongoURI);

app.use('/upload', uploadRoutes);

app.get('/', (req: Request, res: Response) => {
    res.send('Server is running successfully!');
});


export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
// Call this only when your application terminates
export async function disconnectFromMongoDB() {
    await client.close();
}

await connectToMongoDB();

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});