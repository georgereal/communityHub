import mongoose from 'mongoose';
import { getMongoEnv } from '../mongoClient.js';

const globalKey = '__communityHubMongoose';

export async function connectPropertyMongo() {
    const g = globalThis[globalKey] || (globalThis[globalKey] = { connecting: null });
    if (mongoose.connection.readyState === 1) return mongoose;
    if (!g.connecting) {
        const { uri, dbName } = getMongoEnv();
        g.connecting = mongoose.connect(uri, { dbName }).finally(() => {
            g.connecting = null;
        });
    }
    await g.connecting;
    return mongoose;
}
