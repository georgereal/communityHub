import mongoose from 'mongoose';
import { getMongoClientOptions, getMongoEnv } from '../mongoClient.js';

const globalKey = '__communityHubMongoose';

/**
 * One Mongoose connection per serverless isolate (warm reuse).
 * Pool size matches the native driver so Atlas connection count stays low.
 */
export async function connectPropertyMongo() {
    const g = globalThis[globalKey] || (globalThis[globalKey] = { connecting: null });
    if (mongoose.connection.readyState === 1) return mongoose;

    if (!g.connecting) {
        const { uri, dbName } = getMongoEnv();
        mongoose.set('bufferCommands', false);
        g.connecting = mongoose.connect(uri, {
            dbName,
            ...getMongoClientOptions(),
        }).finally(() => {
            g.connecting = null;
        });
    }
    await g.connecting;
    return mongoose;
}
