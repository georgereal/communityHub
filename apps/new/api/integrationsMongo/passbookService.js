import {
    requireEvolyxPassbookConfig,
    resolveEvolyxPassbookConfig,
} from './connectionsStore.js';
import {
    PASSBOOK_JOB_STATUS,
    createPassbookJob,
    sanitizePassbookJob,
    summarizeFiles,
    updatePassbookJob,
} from './passbookJobsStore.js';
import { buildPassbookWebhookUrl, startEvolyxWorkflow, isPublicWebhookBase } from './evolyxWorkflow.js';

/**
 * Create a passbook OCR job and submit files to Evolyx (async webhook completion).
 * Webhook defaults to this API server; optional Integrations override for tunnels.
 */
export async function submitPassbookParse({ req, apartmentId, user, files, requestId, db }) {
    const rid = requestId || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let job = null;
    try {
        const config = requireEvolyxPassbookConfig(
            await resolveEvolyxPassbookConfig(apartmentId, { db }),
        );
        job = await createPassbookJob({
            apartmentId,
            userId: user?.id || null,
            config,
            requestId: rid,
            files,
            db,
        });
        const { webhookUrl, callbackBase, usedOverride } = buildPassbookWebhookUrl(req, {
            webhookBaseUrl: config.webhookBaseUrl,
            jobId: job.id,
            callbackToken: job.callback_token,
        });
        const webhookReachable = isPublicWebhookBase(callbackBase);

        const result = await startEvolyxWorkflow({
            files,
            requestId: rid,
            config,
            webhookUrl,
        });
        const localHint = !webhookReachable
            ? (usedOverride
                ? 'Waiting on Evolyx webhook — override URL is not publicly reachable.'
                : 'Waiting on Evolyx webhook — this API host is not publicly reachable (e.g. localhost). For local tests set Administration → Integrations → Webhook override URL to an https tunnel.')
            : null;
        job = await updatePassbookJob(job.id, {
            status: PASSBOOK_JOB_STATUS.SUBMITTED,
            execution_id: result.executionId || null,
            request_id: result.requestId || rid,
            started_at: new Date().toISOString(),
            provider_response: result,
            webhook_callback_url: webhookUrl,
            webhook_public: webhookReachable,
            webhook_used_override: usedOverride,
            last_error: localHint,
        }, { db });
        return {
            __httpStatus: 202,
            success: true,
            status: PASSBOOK_JOB_STATUS.SUBMITTED,
            job: sanitizePassbookJob(job),
            executionId: result.executionId,
            requestId: result.requestId || rid,
            webhookUrl,
            webhookPublic: webhookReachable,
            webhookUsedOverride: usedOverride,
            warning: localHint || undefined,
        };
    } catch (err) {
        if (job?.id) {
            try {
                await updatePassbookJob(job.id, {
                    status: PASSBOOK_JOB_STATUS.FAILED,
                    completed_at: new Date().toISOString(),
                    last_error: err?.message || 'Passbook parse failed.',
                    last_error_detail: err?.detail || null,
                }, { db });
            } catch {
                // best effort
            }
        }
        err.files = summarizeFiles(files);
        throw err;
    }
}
