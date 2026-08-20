/**
 * Shared MongoDB client for Vercel/Node serverless.
 *
 * Each serverless isolate keeps one client on globalThis so warm invocations
 * reuse the pool. Keep maxPoolSize small: every function instance has its own
 * pool, so a large default (100) would exhaust Atlas connections.
 */
import { MongoClient } from 'mongodb';

const globalKey = '__communityHubMongo';

function requireEnv(name) {
    const value = (process.env[name] || '').trim();
    if (!value) {
        throw Object.assign(new Error(`Missing environment variable ${name}.`), { status: 500 });
    }
    return value;
}

export function getMongoEnv() {
    return {
        uri: requireEnv('MONGODB_URI'),
        dbName: requireEnv('MONGODB_DB_NAME'),
    };
}

/** Options shared by the native driver and Mongoose. */
export function getMongoClientOptions() {
    return {
        maxPoolSize: 1,
        minPoolSize: 0,
        maxIdleTimeMS: 45_000,
        serverSelectionTimeoutMS: 8_000,
        connectTimeoutMS: 10_000,
        retryWrites: true,
    };
}

export async function getMongoClient() {
    const g = globalThis[globalKey] || (globalThis[globalKey] = { client: null, connecting: null });
    if (g.client) return g.client;

    if (!g.connecting) {
        const { uri } = getMongoEnv();
        g.connecting = MongoClient.connect(uri, getMongoClientOptions()).then((client) => {
            g.client = client;
            g.connecting = null;
            return client;
        }).catch((err) => {
            g.connecting = null;
            throw err;
        });
    }
    return g.connecting;
}

export async function getMongoDb() {
    const client = await getMongoClient();
    return client.db(getMongoEnv().dbName);
}
