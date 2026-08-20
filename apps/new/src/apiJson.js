/** Parse fetch Response body safely — avoids "Unexpected end of JSON input". */
export async function readApiJson(res) {
    const text = await res.text();
    if (!text) {
        return {
            ok: res.ok,
            json: {},
            error: res.ok
                ? null
                : `API unavailable (${res.status}). Restart \`npm run dev\` after config changes.`,
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
