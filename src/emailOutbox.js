/**
 * Phase 6.5 — Email outbox queue (processed by Edge Function / Resend)
 */
import { portalState, supabase, pullState } from './store.js';

export async function queueEmail({ recipient_email, subject, body, template_key, related_entity_type, related_entity_id }) {
    if (!supabase) throw new Error('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('email_outbox').insert({
        id: crypto.randomUUID(),
        apartment_id,
        recipient_email: recipient_email.trim(),
        subject,
        body,
        template_key: template_key || null,
        related_entity_type: related_entity_type || null,
        related_entity_id: related_entity_id || null,
        created_by: user?.id,
    });
    if (error) throw new Error(error.message);
    await pullState();
}

/** Test mode: mark pending emails as sent (replace with Edge Function in production) */
export async function processPendingEmailsTestMode() {
    const pending = (portalState.email?.outbox || []).filter((e) => e.status === 'PENDING');
    if (!pending.length) return { processed: 0 };
    for (const row of pending) {
        await supabase.from('email_outbox').update({
            status: 'SENT',
            sent_at: new Date().toISOString(),
        }).eq('id', row.id);
    }
    await pullState();
    return { processed: pending.length };
}

export const renderEmailOutbox = () => {
    const el = document.getElementById('email-outbox-list');
    if (!el) return;
    const rows = portalState.email?.outbox || [];
    if (!rows.length) {
        el.innerHTML = '<p class="ops-empty">No emails queued. Use Compose or reminder actions to enqueue.</p>';
        return;
    }
    el.innerHTML = rows.slice(0, 50).map((e) => `<div class="email-outbox-row">
      <div><strong>${e.recipient_email}</strong> — ${e.subject}</div>
      <div><span class="portal-status portal-status--${e.status.toLowerCase()}">${e.status}</span>
        ${e.sent_at ? new Date(e.sent_at).toLocaleString('en-IN') : new Date(e.created_at).toLocaleString('en-IN')}</div>
    </div>`).join('');
};

export const initEmailOutbox = () => {
    document.getElementById('email-compose-save')?.addEventListener('click', async () => {
        const to = document.getElementById('email-compose-to')?.value;
        const subject = document.getElementById('email-compose-subject')?.value;
        const body = document.getElementById('email-compose-body')?.value;
        if (!to?.trim() || !subject?.trim()) return alert('To and subject required.');
        try {
            await queueEmail({ recipient_email: to, subject, body });
            document.getElementById('email-compose-modal')?.classList.remove('active');
            renderEmailOutbox();
        } catch (e) { alert(e.message); }
    });
    document.getElementById('email-compose-cancel')?.addEventListener('click', () => {
        document.getElementById('email-compose-modal')?.classList.remove('active');
    });
    document.getElementById('email-outbox-compose')?.addEventListener('click', () => {
        document.getElementById('email-compose-form')?.reset();
        document.getElementById('email-compose-modal')?.classList.add('active');
    });
    document.getElementById('email-outbox-process')?.addEventListener('click', async () => {
        try {
            const { processed } = await processPendingEmailsTestMode();
            alert(processed ? `Marked ${processed} email(s) as sent (test mode).` : 'No pending emails.');
            renderEmailOutbox();
        } catch (e) { alert(e.message); }
    });
};
