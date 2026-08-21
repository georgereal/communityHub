/**
 * Legacy /api/external-connections — Mongo-backed via integrations domain.
 * Prefer /api/integrations/connections for New UI.
 */
import { requireApartmentPermission } from '../../../packages/server/serverAuth.js';
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import {
    listExternalConnections,
    upsertExternalConnection,
} from './integrationsMongo/connectionsStore.js';
import { ensureIntegrationsIndexes } from './integrationsMongo/indexes.js';

export default async function handler(req, res) {
    const apartmentIdRaw = req.method === 'GET'
        ? req.query?.apartment_id || new URL(req.url, 'http://localhost').searchParams.get('apartment_id')
        : req.body?.apartment_id;

    try {
        const { apartmentId, user } = await requireApartmentPermission(req, apartmentIdRaw, 'accounts.edit');
        const db = await getMongoDb();
        await ensureIntegrationsIndexes(db);

        if (req.method === 'GET') {
            const rows = await listExternalConnections(apartmentId, { db });
            return res.status(200).json({ ok: true, rows });
        }

        if (req.method === 'POST') {
            const row = await upsertExternalConnection(apartmentId, user?.id, req.body || {}, { db });
            return res.status(200).json({ ok: true, row });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'External connections request failed.' });
    }
}
