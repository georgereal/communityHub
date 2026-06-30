#!/usr/bin/env node
/**
 * Capture finance reports & bank reconciliation screenshots with mock data.
 * Usage: node scripts/capture-finance-screenshots.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMockFinanceState, buildMockNoBrokerLines } from './mockFinanceState.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = process.env.SCREENSHOT_DIR || '/opt/cursor/artifacts/screenshots';
const port = 5173;
const baseUrl = `http://127.0.0.1:${port}`;

mkdirSync(outDir, { recursive: true });

function waitForServer(url, timeoutMs = 30000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = async () => {
            try {
                const res = await fetch(url);
                if (res.ok) return resolve();
            } catch {
                /* retry */
            }
            if (Date.now() - start > timeoutMs) return reject(new Error(`Server not ready: ${url}`));
            setTimeout(tick, 400);
        };
        tick();
    });
}

function startVite() {
    const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: root,
        stdio: 'pipe',
        env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    });
    return child;
}

async function hideOverlays(page) {
    await page.evaluate(() => {
        document.getElementById('auth-modal')?.classList.remove('active');
        document.getElementById('sentry-boot-loader')?.remove();
        document.body.classList.add('nav-expanded');
    });
}

async function seedNoBroker(page) {
    const lines = buildMockNoBrokerLines();
    await page.evaluate(({ lines, fileName }) => {
        window.__demoNobroker = { lines, fileName };
    }, { lines, fileName: 'NoBroker_May-Jun_2026.xlsx' });

    await page.evaluate(async () => {
        const mod = await import('/src/bankReconciliation.js');
        mod.setNoBrokerDump(window.__demoNobroker.lines, window.__demoNobroker.fileName);
    });
}

async function capture(page, hash, filename, { seedNobroker = false, waitMs = 2500 } = {}) {
    const mockState = buildMockFinanceState();
    await page.addInitScript((state) => {
        localStorage.setItem('sentry_portal_v5_platinum', JSON.stringify(state));
    }, mockState);

    await page.goto(`${baseUrl}/#${hash}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(waitMs);
    await hideOverlays(page);

    if (seedNobroker) {
        await seedNoBroker(page);
        await page.evaluate(() => {
            window.renderFinanceAnalytics?.();
            window.renderBankReconciliation?.();
        });
        await page.waitForTimeout(1200);
    }

    await page.screenshot({
        path: join(outDir, filename),
        fullPage: true,
    });
    console.log(`Saved ${join(outDir, filename)}`);
}

async function main() {
    const vite = startVite();
    try {
        await waitForServer(baseUrl);
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 2,
        });
        const page = await context.newPage();

        await capture(page, 'finance-reports', 'finance-reports-mock.png', { seedNobroker: true, waitMs: 3500 });
        await capture(page, 'finance-bank-recon', 'finance-bank-recon-mock.png', { seedNobroker: true, waitMs: 3000 });

        await browser.close();
    } finally {
        vite.kill('SIGTERM');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
