/**
 * Ensure Chart.js global is available (SPA loads via CDN; MPA pages may not).
 */
const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

let chartLoadPromise = null;

export function ensureChartJs() {
    if (typeof globalThis.Chart !== 'undefined') {
        return Promise.resolve(globalThis.Chart);
    }
    if (chartLoadPromise) return chartLoadPromise;

    chartLoadPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-app-shell-chartjs]`);
        if (existing) {
            existing.addEventListener('load', () => resolve(globalThis.Chart));
            existing.addEventListener('error', () => reject(new Error('Chart.js failed to load')));
            return;
        }
        const script = document.createElement('script');
        script.src = CHART_CDN;
        script.async = true;
        script.dataset.appShellChartjs = '1';
        script.onload = () => {
            if (typeof globalThis.Chart === 'undefined') {
                reject(new Error('Chart.js loaded but Chart is undefined'));
                return;
            }
            resolve(globalThis.Chart);
        };
        script.onerror = () => reject(new Error('Chart.js failed to load'));
        document.head.appendChild(script);
    });

    return chartLoadPromise;
}
