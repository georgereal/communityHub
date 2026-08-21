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
import { callbackBaseUrl, startEvolyxWorkflow, isPublicWebhookBase } from './evolyxWorkflow.js';

/**
 * Create a passbook OCR job and submit files to Evolyx (async webhook completion).
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
        const callbackBase = callbackBaseUrl(req, config.webhookBaseUrl);
        const webhook = new URL('api/passbook-webhook', callbackBase.endsWith('/') ? callbackBase : `${callbackBase}/`);
        webhook.searchParams.set('job_id', job.id);
        webhook.searchParams.set('token', String(job.callback_token || ''));
        const webhookUrl = webhook.toString();
        const webhookReachable = isPublicWebhookBase(callbackBase);

        const result = await startEvolyxWorkflow({
            files,
            requestId: rid,
            config,
            webhookUrl,
        });
        job = await updatePassbookJob(job.id, {
            status: PASSBOOK_JOB_STATUS.SUBMITTED,
            execution_id: result.executionId || null,
            request_id: result.requestId || rid,
            started_at: new Date().toISOString(),
            provider_response: result,
            webhook_callback_url: webhookUrl,
            webhook_public: webhookReachable,
            last_error: webhookReachable
                ? null
                : 'Waiting on Evolyx webhook — callback URL is not publicly reachable (localhost/private). Set Administration → Integrations → This app’s public URL to an https tunnel (ngrok, Cloudflare Tunnel) pointing at this app.',
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
            warning: webhookReachable
                ? undefined
                : 'Job queued at Evolyx, but the webhook URL is not public. Status will stay Queued until Evolyx can POST /api/passbook-webhook. Configure a public tunnel URL under Administration → Integrations.',
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
