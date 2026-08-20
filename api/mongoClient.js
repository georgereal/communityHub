/**
 * Shared MongoDB client for Vercel/Node serverless (warm-instance reuse).
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

export async function getMongoDb() {
    const g = globalThis[globalKey] || (globalThis[globalKey] = { client: null, connecting: null });
    if (g.client) return g.client.db(getMongoEnv().dbName);

    if (!g.connecting) {
        const { uri } = getMongoEnv();
        g.connecting = MongoClient.connect(uri).then((client) => {
            g.client = client;
            g.connecting = null;
            return client;
        }).catch((err) => {
            g.connecting = null;
            throw err;
        });
    }
    const client = await g.connecting;
    return client.db(getMongoEnv().dbName);
}
