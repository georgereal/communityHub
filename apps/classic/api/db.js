import { runDbQuery } from './dbAccess.js';
import { readJsonBody } from '../../../packages/server/vercelRequest.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const body = await readJsonBody(req);

        if (Array.isArray(body.batch)) {
            const results = [];
            for (const query of body.batch) {
                const { data, error } = await runDbQuery(req, query);
                results.push({ data: data ?? null, error: error ? { message: error.message } : null });
            }
            return res.status(200).json({ results });
        }

        const { data, error } = await runDbQuery(req, body);
        if (error) {
            return res.status(error.status || 400).json({ data: null, error: { message: error.message } });
        }
        return res.status(200).json({ data, error: null });
    } catch (err) {
        return res.status(err.status || 500).json({
            data: null,
            error: { message: err.message || 'Database request failed.' },
        });
    }
}
