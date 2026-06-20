/**
 * Admin UI — sync run history and per-run audit logs (Vercel cron / browser / API).
 */

import { portalState, supabase } from './store.js';
import { fetchSyncRunLogs, fetchSyncRuns, formatRunSource, formatRunStatus } from './ledgerSyncJournal.js';

const LEVEL_CLASS = {
    error: 'sync-run-log__level--error',
    warn: 'sync-run-log__level--warn',
    skip: 'sync-run-log__level--skip',
    parse: 'sync-run-log__level--parse',
    db: 'sync-run-log__level--db',
    info: 'sync-run-log__level--info',
};

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'medium' });
}

function fmtDuration(started, completed) {
    if (!started || !completed) return '—';
    const ms = new Date(completed) - new Date(started);
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function summaryCounts(run) {
    const parts = [];
    if (run.imported) parts.push(`${run.imported} in`);
    if (run.updated) parts.push(`${run.updated} up`);
    if (run.deleted) parts.push(`${run.deleted} del`);
    if (run.pushed) parts.push(`${run.pushed} push`);
    if (run.skipped) parts.push(`${run.skipped} skip`);
    return parts.length ? parts.join(', ') : '—';
}

function renderRunLogsHtml(logs) {
    if (!logs?.length) {
        return '<p class="gate-wizard__hint">No trace lines recorded for this run.</p>';
    }
    return `
      <div class="sync-run-log-viewer">
        <table class="sync-run-log-table">
          <thead>
            <tr><th>Time</th><th>Level</th><th>Message</th></tr>
          </thead>
          <tbody>
            ${logs.map((line) => {
                const cls = LEVEL_CLASS[line.level] || LEVEL_CLASS.info;
                let msg = esc(line.message);
                if (line.detail) {
                    msg += ` <span class="sync-run-log__detail">${esc(JSON.stringify(line.detail))}</span>`;
                }
                return `<tr class="sync-run-log__row sync-run-log__row--${line.level}">
                  <td>${fmtTime(line.logged_at)}</td>
                  <td class="sync-run-log__level ${cls}">${esc(String(line.level || 'info').toUpperCase())}</td>
                  <td>${msg}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
}

async function loadRunLogs(runId, container) {
    container.innerHTML = '<p class="gate-wizard__hint"><i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Loading logs…</p>';
    try {
        const logs = await fetchSyncRunLogs(supabase, runId);
        container.innerHTML = renderRunLogsHtml(logs);
    } catch (err) {
        container.innerHTML = `<p class="gate-wizard__hint sync-run-log__error">${esc(err.message)}</p>`;
    }
}

function wireRunTable(rootEl, onRefresh) {
    rootEl.querySelectorAll('[data-sync-run-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const runId = btn.dataset.syncRunToggle;
            const row = rootEl.querySelector(`[data-sync-run-detail="${runId}"]`);
            if (!row) return;
            const open = row.hidden;
            rootEl.querySelectorAll('[data-sync-run-detail]').forEach((el) => { el.hidden = true; });
            rootEl.querySelectorAll('[data-sync-run-toggle]').forEach((b) => {
                b.setAttribute('aria-expanded', 'false');
            });
            if (open) {
                row.hidden = false;
                btn.setAttribute('aria-expanded', 'true');
                const logHost = row.querySelector('[data-sync-run-logs]');
                if (logHost && !logHost.dataset.loaded) {
                    await loadRunLogs(runId, logHost);
                    logHost.dataset.loaded = '1';
                }
            }
        });
    });

    rootEl.querySelector('#sync-run-audit-refresh')?.addEventListener('click', () => onRefresh?.());
}

function renderRunsTable(runs) {
    if (!runs?.length) {
        return `
          <p class="gate-wizard__hint">No sync runs recorded yet. Runs appear here after browser sync, manual server sync, or Vercel cron.</p>
          <p class="gate-wizard__hint">If this stays empty, run <code>supabase_ledger_sync_run_logs.sql</code> in Supabase.</p>`;
    }

    return `
      <div class="sync-run-audit-table-wrap">
        <table class="sync-run-audit-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Source</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Changes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${runs.map((run) => {
                const st = formatRunStatus(run.status);
                return `
              <tr class="sync-run-audit-table__row sync-run-audit-table__row--${run.status?.toLowerCase() || 'unknown'}">
                <td>${fmtTime(run.started_at)}</td>
                <td><span class="sync-run-source sync-run-source--${run.source || 'browser'}">${esc(formatRunSource(run.source))}</span></td>
                <td><span class="sync-run-status sync-run-status--${st.key}">${esc(st.label)}</span></td>
                <td>${fmtDuration(run.started_at, run.completed_at)}</td>
                <td>${esc(summaryCounts(run))}</td>
                <td>
                  <button type="button" class="btn btn-outline btn--small" data-sync-run-toggle="${run.id}" aria-expanded="false">
                    Logs
                  </button>
                </td>
              </tr>
              <tr class="sync-run-audit-detail" data-sync-run-detail="${run.id}" hidden>
                <td colspan="6">
                  <div class="sync-run-audit-detail__inner">
                    ${run.message ? `<p class="sync-run-audit-detail__msg">${esc(run.message)}</p>` : ''}
                    <div data-sync-run-logs="${run.id}"></div>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
}

export async function renderSyncRunAuditPanel(containerId = 'admin-sync-run-audit') {
    const el = document.getElementById(containerId);
    if (!el) return;

    const apartment_id = portalState.access?.activeApartmentId;
    if (!supabase || !apartment_id) {
        el.innerHTML = '<p class="gate-wizard__hint">Select a society to view sync run history.</p>';
        return;
    }

    el.innerHTML = `
      <div class="sync-run-audit">
        <div class="sync-run-audit__toolbar">
          <p class="sync-step-hint" style="margin:0;">
            Audit trail for Vercel cron, server API, and browser sync. Click <strong>Logs</strong> on a run for row-by-row details.
          </p>
          <button type="button" class="btn btn-outline btn--small" id="sync-run-audit-refresh">
            <i class="fa-solid fa-arrows-rotate"></i> Refresh
          </button>
        </div>
        <p class="gate-wizard__hint"><i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Loading runs…</p>
      </div>`;

    const paint = async () => {
        try {
            const runs = await fetchSyncRuns(supabase, apartment_id, { limit: 40 });
            const host = el.querySelector('.sync-run-audit');
            if (!host) return;
            host.innerHTML = `
              <div class="sync-run-audit__toolbar">
                <p class="sync-step-hint" style="margin:0;">
                  Audit trail for Vercel cron, server API, and browser sync. Click <strong>Logs</strong> on a run for row-by-row details.
                </p>
                <button type="button" class="btn btn-outline btn--small" id="sync-run-audit-refresh">
                  <i class="fa-solid fa-arrows-rotate"></i> Refresh
                </button>
              </div>
              ${renderRunsTable(runs)}`;
            wireRunTable(host, () => renderSyncRunAuditPanel(containerId));
        } catch (err) {
            el.innerHTML = `<p class="gate-wizard__hint">${esc(err.message)}</p>`;
        }
    };

    await paint();
}
