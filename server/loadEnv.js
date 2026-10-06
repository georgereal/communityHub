import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader (no dotenv dependency). Does not override existing process.env.
 */
export function loadEnvFile(filePath) {
    const abs = resolve(filePath);
    if (!existsSync(abs)) return false;
    const text = readFileSync(abs, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (process.env[key] == null || process.env[key] === '') {
            process.env[key] = value;
        }
    }
    return true;
}

export function loadServerEnv() {
    const candidates = [
        process.env.COMMUNITYHUB_ENV_FILE,
        resolve(process.cwd(), '.env.production'),
        resolve(process.cwd(), '.env'),
        resolve(process.cwd(), '.env.local'),
    ].filter(Boolean);

    for (const file of candidates) {
        if (loadEnvFile(file)) {
            console.log(`[server] loaded env from ${file}`);
            return file;
        }
    }
    return null;
}
