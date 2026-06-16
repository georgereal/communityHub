/**
 * Notice delivery — portal/app alerts, email & SMS queues
 */
import { portalState, supabase, pullState } from './store.js';
import { getUnitBlock } from './blockFilter.js';
import { loadResidents, normUnit } from './residents.js';
import { stripNoticeHtml } from './noticeEditor.js';

const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

const defaultChannels = () => ({ portal: true, email: false, sms: false });

export const parseNoticeChannels = (notice) => {
    const raw = notice?.delivery_channels;
    if (!raw || typeof raw !== 'object') return defaultChannels();
    return {
        portal: raw.portal !== false,
        email: !!raw.email,
        sms: !!raw.sms,
    };
};

export function collectNoticeDeliveryChannels() {
    const portal = document.getElementById('notice-ch-portal')?.checked ?? true;
    const email = document.getElementById('notice-ch-email')?.checked ?? false;
    const sms = document.getElementById('notice-ch-sms')?.checked ?? false;
    if (!portal && !email && !sms) return null;
    return { portal, email, sms };
}

export function setNoticeDeliveryChannelInputs(channels = defaultChannels()) {
    const portalEl = document.getElementById('notice-ch-portal');
    const emailEl = document.getElementById('notice-ch-email');
    const smsEl = document.getElementById('notice-ch-sms');
    if (portalEl) portalEl.checked = channels.portal !== false;
    if (emailEl) emailEl.checked = !!channels.email;
    if (smsEl) smsEl.checked = !!channels.sms;
}

export const channelsLabel = (notice) => {
    const ch = parseNoticeChannels(notice);
    const parts = [];
    if (ch.portal) parts.push('Portal');
    if (ch.email) parts.push('Email');
    if (ch.sms) parts.push('SMS');
    return parts.length ? parts.join(' · ') : '—';
};

export async function getResidentsForNoticeAudience(notice) {
    const all = await loadResidents(true);

    if (notice.audience === 'BLOCKS') {
        const blocks = new Set((notice.block_filters || []).map((b) => String(b).toUpperCase()));
        return all.filter((r) => {
            const unit = portalState.units.find((u) => normUnit(u.number) === normUnit(r.unit_number));
            const block = getUnitBlock(unit).toUpperCase();
            return block && blocks.has(block);
        });
    }

    if (notice.audience === 'UNITS') {
        const unitNums = new Set(
            (notice.unit_ids || [])
                .map((id) => portalState.units.find((u) => u.id === id)?.number)
                .filter(Boolean)
                .map(normUnit),
        );
        return all.filter((r) => unitNums.has(normUnit(r.unit_number)));
    }

    return all;
}

export async function estimateNoticeDelivery(notice, channels = parseNoticeChannels(notice)) {
    const residents = await getResidentsForNoticeAudience(notice);
    const emails = new Set();
    const phones = new Set();
    residents.forEach((r) => {
        const email = (r.email || '').trim().toLowerCase();
        if (email) emails.add(email);
        const phone = normPhone(r.phone);
        if (phone.length >= 10) phones.add(phone);
    });

    const links = portalState.portal?.residentLinks || [];
    const residentIds = new Set(residents.map((r) => r.id));
    const appUsers = new Set(
        links.filter((l) => residentIds.has(l.resident_id)).map((l) => l.user_id),
    );

    return {
        residents: residents.length,
        email: channels.email ? emails.size : 0,
        sms: channels.sms ? phones.size : 0,
        app: channels.portal ? appUsers.size : 0,
        skippedEmail: channels.email ? residents.length - emails.size : 0,
        skippedSms: channels.sms ? residents.length - phones.size : 0,
        skippedApp: channels.portal ? residents.length - appUsers.size : 0,
    };
}

async function queueSmsBatch(rows) {
    if (!rows.length || !supabase) return 0;
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const payload = rows.map((row) => ({
        id: crypto.randomUUID(),
        apartment_id,
        recipient_phone: row.recipient_phone,
        body: row.body,
        template_key: row.template_key || 'NOTICE',
        related_entity_type: 'SOCIETY_NOTICE',
        related_entity_id: row.notice_id,
        created_by: user?.id,
    }));
    const { error } = await supabase.from('sms_outbox').insert(payload);
    if (error) throw new Error(error.message);
    return payload.length;
}

async function queueAppNotifications(notice, userIds) {
    if (!userIds.length || !supabase) return 0;
    const apartment_id = portalState.access?.activeApartmentId;
    const plain = stripNoticeHtml(notice.body).slice(0, 500);
    const payload = [...userIds].map((user_id) => ({
        id: crypto.randomUUID(),
        apartment_id,
        user_id,
        notice_id: notice.id,
        title: notice.title,
        body: plain,
    }));
    const { error } = await supabase.from('user_notifications').insert(payload);
    if (error) throw new Error(error.message);
    return payload.length;
}

export async function dispatchNoticeDelivery(notice) {
    const channels = parseNoticeChannels(notice);
    const residents = await getResidentsForNoticeAudience(notice);
    const summary = {
        portal: channels.portal,
        email: { queued: 0, skipped: 0 },
        sms: { queued: 0, skipped: 0 },
        app: { notified: 0, skipped: 0 },
    };

    const plainBody = stripNoticeHtml(notice.body);
    const smsBody = `${notice.title}: ${plainBody}`.slice(0, 480);

    if (channels.email) {
        const seen = new Set();
        const emailRows = [];
        let skipped = 0;
        for (const r of residents) {
            const email = (r.email || '').trim().toLowerCase();
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                skipped += 1;
                continue;
            }
            if (seen.has(email)) continue;
            seen.add(email);
            emailRows.push({ email, name: r.full_name });
        }
        if (emailRows.length) {
            const apartment_id = portalState.access?.activeApartmentId;
            const { data: { user } } = await supabase.auth.getUser();
            const payload = emailRows.map((row) => ({
                id: crypto.randomUUID(),
                apartment_id,
                recipient_email: row.email,
                subject: `[Notice] ${notice.title}`,
                body: `${row.name ? `Dear ${row.name},\n\n` : ''}${plainBody}\n\n— Society office`,
                template_key: 'NOTICE',
                related_entity_type: 'SOCIETY_NOTICE',
                related_entity_id: notice.id,
                created_by: user?.id,
            }));
            const { error } = await supabase.from('email_outbox').insert(payload);
            if (error) throw new Error(error.message);
        }
        summary.email = { queued: emailRows.length, skipped };
    }

    if (channels.sms) {
        const seen = new Set();
        const smsRows = [];
        let skipped = 0;
        for (const r of residents) {
            const phone = normPhone(r.phone);
            if (phone.length < 10) {
                skipped += 1;
                continue;
            }
            if (seen.has(phone)) continue;
            seen.add(phone);
            smsRows.push({ recipient_phone: phone, body: smsBody, notice_id: notice.id });
        }
        summary.sms = { queued: await queueSmsBatch(smsRows), skipped };
    }

    if (channels.portal) {
        const links = portalState.portal?.residentLinks || [];
        const residentIds = new Set(residents.map((r) => r.id));
        const userIds = new Set(
            links.filter((l) => residentIds.has(l.resident_id)).map((l) => l.user_id),
        );
        const notified = await queueAppNotifications(notice, [...userIds]);
        summary.app = {
            notified,
            skipped: Math.max(0, residents.length - notified),
        };
    }

    if (supabase) {
        await supabase.from('society_notices')
            .update({ delivery_summary: summary })
            .eq('id', notice.id);
    }

    await pullState();
    return summary;
}

export function formatDeliverySummary(notice) {
    const s = notice?.delivery_summary;
    if (!s || !notice.published_at) return '';
    const parts = [];
    if (s.email?.queued) parts.push(`${s.email.queued} email`);
    if (s.sms?.queued) parts.push(`${s.sms.queued} SMS`);
    if (s.app?.notified) parts.push(`${s.app.notified} app`);
    return parts.length ? parts.join(' · ') : '';
}
