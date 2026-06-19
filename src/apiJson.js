/** Parse fetch Response body safely — avoids "Unexpected end of JSON input". */
export async function readApiJson(res) {
    const text = await res.text();
    if (!text) {
        return {
            ok: res.ok,
            json: {},
            error: res.ok
                ? null
                : `Empty response from server (${res.status}). API routes may be unavailable — use production or \`vercel dev\`.`,
        };
    }
    try {
        return { ok: res.ok, json: JSON.parse(text), error: null };
    } catch {
        return {
            ok: res.ok,
            json: {},
            error: `Invalid server response (${res.status}): ${text.slice(0, 120)}`,
        };
    }
}
