/**
 * Phase 3.3 — Society notices (admin + portal)
 */
import './notices.css';
import { portalState, supabase, pullState } from './store.js';
import { getUnitBlock, getBlockOptions } from './blockFilter.js';
import { loadResidents, normUnit } from './residents.js';
import {
    initNoticeEditor,
    resetNoticeEditor,
    getNoticeEditorHtml,
    stripNoticeHtml,
} from './noticeEditor.js';
import {
    collectNoticeDeliveryChannels,
    setNoticeDeliveryChannelInputs,
    parseNoticeChannels,
    channelsLabel,
    estimateNoticeDelivery,
    dispatchNoticeDelivery,
    formatDeliverySummary,
} from './noticeDelivery.js';
import { bindBusyClick } from './buttonBusy.js';

const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let noticeFilter = 'all';

const getMyUnitIds = async () => {
    const uid = portalState.auth?.id;
    if (!uid) return [];
    const links = (portalState.portal?.residentLinks || []).filter((l) => l.user_id === uid);
    const residents = await loadResidents();
    const unitNums = new Set();
    links.forEach((link) => {
        const r = residents.find((x) => x.id === link.resident_id);
        if (r?.unit_number) unitNums.add(normUnit(r.unit_number));
    });
    return portalState.units
        .filter((u) => unitNums.has(normUnit(u.number)))
        .map((u) => u.id);
};

const priorityBadge = (p) => {
    const key = (p || 'normal').toLowerCase();
    return `<span class="notice-priority notice-priority--${key}">${p || 'NORMAL'}</span>`;
};

const audienceLabel = (n) => {
    if (n.audience === 'BLOCKS') {
        const blocks = (n.block_filters || []).filter(Boolean);
        return blocks.length ? blocks.join(', ') : 'Specific blocks';
    }
    if (n.audience === 'UNITS') return 'Selected flats';
    return 'All residents';
};

const filterNotices = (notices) => {
    if (noticeFilter === 'draft') return notices.filter((n) => !n.published_at);
    if (noticeFilter === 'published') return notices.filter((n) => n.published_at);
    return notices;
};

function renderNoticeStats(notices) {
    const el = document.getElementById('notice-stats');
    if (!el) return;
    const drafts = notices.filter((n) => !n.published_at).length;
    const published = notices.filter((n) => n.published_at).length;
    el.innerHTML = `
      <div class="metric-card">
        <span class="label">Total</span>
        <span class="value">${notices.length}</span>
      </div>
      <div class="metric-card">
        <span class="label">Drafts</span>
        <span class="value value--accent">${drafts}</span>
      </div>
      <div class="metric-card">
        <span class="label">Published</span>
        <span class="value value--success">${published}</span>
      </div>`;
}

function syncFilterTabs() {
    document.querySelectorAll('#notice-filters [data-notice-filter]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.noticeFilter === noticeFilter);
    });
}

export const getPublishedNotices = () =>
    (portalState.portal?.notices || []).filter((n) => {
        if (!n.published_at) return false;
        return parseNoticeChannels(n).portal;
    });

export async function getNoticesForUser() {
    const published = getPublishedNotices().filter((n) => {
        if (n.expires_at && new Date(n.expires_at) < new Date()) return false;
        return true;
    });

    const uid = portalState.auth?.id;
    const readSet = new Set(
        (portalState.portal?.noticeReadLog || [])
            .filter((r) => r.user_id === uid)
            .map((r) => r.notice_id),
    );

    const unitIds = await getMyUnitIds();
    const myBlocks = new Set(
        portalState.units
            .filter((u) => unitIds.includes(u.id))
            .map((u) => getUnitBlock(u).toUpperCase())
            .filter(Boolean),
    );

    const filtered = published.filter((n) => {
        if (n.audience === 'ALL') return true;
        if (n.audience === 'BLOCKS') {
            const blocks = (n.block_filters || []).map((b) => String(b).toUpperCase());
            if (!blocks.length) return true;
            return blocks.some((b) => myBlocks.has(b));
        }
        if (n.audience === 'UNITS') {
            const ids = n.unit_ids || [];
            if (!ids.length) return true;
            return ids.some((id) => unitIds.includes(id));
        }
        return true;
    });

    return filtered.map((n) => ({ ...n, _read: readSet.has(n.id) }));
}

export async function markNoticeRead(noticeId) {
    if (!supabase) return;
    const uid = portalState.auth?.id;
    if (!uid) return;
    await supabase.from('notice_read_log').upsert({
        notice_id: noticeId,
        user_id: uid,
        read_at: new Date().toISOString(),
    }, { onConflict: 'notice_id,user_id' });
    await pullState();
}

export const renderNoticesAdmin = () => {
    const el = document.getElementById('ops-notices-list');
    if (!el) return;

    const all = [...(portalState.portal?.notices || [])]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    renderNoticeStats(all);
    syncFilterTabs();

    const notices = filterNotices(all);
    if (!notices.length) {
        const msg = noticeFilter === 'draft'
            ? 'No drafts yet.'
            : noticeFilter === 'published'
                ? 'Nothing published yet.'
                : 'No notices yet — use New notice above to create your first circular.';
        el.innerHTML = `<div class="registry-list notice-registry">
          <div class="notice-empty-panel">
            <i class="fa-solid fa-bullhorn"></i>
            <p>${msg}</p>
          </div>
        </div>`;
        return;
    }

    el.innerHTML = `
      <div class="registry-list notice-registry">
        <div class="registry-header">
          <span>Notice</span>
          <span>Priority</span>
          <span>Audience</span>
          <span>Status</span>
          <span>Date</span>
          <span></span>
        </div>
        ${notices.map((n) => {
        const isDraft = !n.published_at;
        const previewText = stripNoticeHtml(n.body || '');
        const preview = previewText.slice(0, 90);
        const dateLabel = n.published_at
            ? new Date(n.published_at).toLocaleDateString('en-IN')
            : new Date(n.created_at).toLocaleDateString('en-IN');
        const deliveryLabel = escHtml(channelsLabel(n));
        const sentLabel = formatDeliverySummary(n) ? ` · ${escHtml(formatDeliverySummary(n))}` : '';
        const deliveryMeta = n.published_at ? `${deliveryLabel}${sentLabel}` : deliveryLabel;
        return `<div class="ops-notice-row ${isDraft ? 'ops-notice-row--draft' : ''}">
          <div class="ops-notice-row__title">
            <strong>${escHtml(n.title)}</strong>
            <span class="ops-notice-row__preview">${escHtml(preview)}${previewText.length > 90 ? '…' : ''}</span>
            <span class="ops-notice-row__delivery"><i class="fa-solid fa-paper-plane"></i> ${deliveryMeta}</span>
          </div>
          <div>${priorityBadge(n.priority)}</div>
          <div class="ops-notice-row__audience">${escHtml(audienceLabel(n))}</div>
          <div><span class="notice-status ${isDraft ? 'notice-status--draft' : 'notice-status--live'}">${isDraft ? 'Draft' : 'Live'}</span></div>
          <div class="ops-notice-row__date">${dateLabel}</div>
          <div class="ops-notice-row__actions">
            ${isDraft ? `<button type="button" class="btn btn-primary btn--small" data-publish="${n.id}">Publish</button>` : ''}
            <button type="button" class="btn btn-outline btn--small" data-del-notice="${n.id}" title="Delete" style="color:var(--danger);">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>`;
    }).join('')}
      </div>`;

    el.querySelectorAll('[data-publish]').forEach((btn) => {
        btn.onclick = () => void publishNotice(btn.dataset.publish);
    });
    el.querySelectorAll('[data-del-notice]').forEach((btn) => {
        btn.onclick = () => void deleteNotice(btn.dataset.delNotice);
    });
};

async function publishNotice(id) {
    if (!supabase) return;
    const notice = portalState.portal?.notices?.find((n) => n.id === id);
    if (!notice) return;

    const channels = parseNoticeChannels(notice);
    const est = await estimateNoticeDelivery(notice, channels);
    const lines = [
        `Publish "${notice.title}" to ${audienceLabel(notice).toLowerCase()}?`,
        '',
        'Delivery:',
        channels.portal ? `• Portal & app alerts — ${est.app} linked account(s)` : null,
        channels.email ? `• Email — ${est.email} recipient(s)${est.skippedEmail ? ` (${est.skippedEmail} without email)` : ''}` : null,
        channels.sms ? `• SMS — ${est.sms} recipient(s)${est.skippedSms ? ` (${est.skippedSms} without phone)` : ''}` : null,
    ].filter(Boolean).join('\n');
    if (!confirm(lines)) return;

    const { error } = await supabase.from('society_notices')
        .update({ published_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return alert(error.message);
    await pullState();

    const updated = portalState.portal?.notices?.find((n) => n.id === id) || notice;
    try {
        const summary = await dispatchNoticeDelivery({ ...updated, published_at: updated.published_at || new Date().toISOString() });
        const sent = [
            summary.email?.queued ? `${summary.email.queued} email(s) queued` : null,
            summary.sms?.queued ? `${summary.sms.queued} SMS queued` : null,
            summary.app?.notified ? `${summary.app.notified} app alert(s)` : null,
        ].filter(Boolean).join(', ');
        if (sent) alert(`Published. ${sent}.`);
    } catch (e) {
        alert(`Notice published on portal, but delivery failed: ${e.message}`);
    }

    renderNoticesAdmin();
}

async function deleteNotice(id) {
    if (!confirm('Delete this notice? This cannot be undone.')) return;
    const { error } = await supabase.from('society_notices').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
    renderNoticesAdmin();
}

function renderBlockChips() {
    const el = document.getElementById('notice-block-chips');
    if (!el) return;
    const blocks = getBlockOptions();
    if (!blocks.length) {
        el.innerHTML = '<p class="notice-compose-form__hint">No blocks found in unit directory.</p>';
        return;
    }
    el.innerHTML = blocks.map((b) =>
        `<button type="button" class="notice-block-chip" data-block="${escHtml(b)}">${escHtml(b)}</button>`,
    ).join('');
    el.querySelectorAll('.notice-block-chip').forEach((chip) => {
        chip.addEventListener('click', () => chip.classList.toggle('active'));
    });
}

function setPriority(value) {
    const hidden = document.getElementById('notice-priority');
    if (hidden) hidden.value = value;
    document.querySelectorAll('.notice-priority-pill').forEach((pill) => {
        pill.classList.toggle('active', pill.dataset.priority === value);
    });
}

function syncAudiencePanel() {
    const audience = document.getElementById('notice-audience')?.value;
    const wrap = document.getElementById('notice-blocks-wrap');
    if (wrap) wrap.hidden = audience !== 'BLOCKS';
}

function showListView() {
    document.getElementById('notice-list-view')?.removeAttribute('hidden');
    document.getElementById('notice-compose-view')?.setAttribute('hidden', '');
}

function showComposeView() {
    document.getElementById('notice-list-view')?.setAttribute('hidden', '');
    document.getElementById('notice-compose-view')?.removeAttribute('hidden');
}

export const openNoticeComposer = () => {
    resetNoticeEditor();
    setPriority('NORMAL');
    setNoticeDeliveryChannelInputs();
    document.getElementById('notice-form')?.reset();
    setNoticeDeliveryChannelInputs();
    document.querySelectorAll('.notice-block-chip.active').forEach((c) => c.classList.remove('active'));
    renderBlockChips();
    syncAudiencePanel();
    showComposeView();
    quillFocus();
};

function quillFocus() {
    const editor = initNoticeEditor();
    editor?.focus();
}

function closeNoticeComposer() {
    showListView();
}

export const saveNotice = async () => {
    if (!supabase) return alert('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    const title = document.getElementById('notice-title')?.value?.trim();
    const body = getNoticeEditorHtml();
    const priority = document.getElementById('notice-priority')?.value || 'NORMAL';
    const audience = document.getElementById('notice-audience')?.value || 'ALL';
    const expiresRaw = document.getElementById('notice-expires')?.value?.trim();

    if (!title || !body) return alert('Headline and message are required.');

    const delivery_channels = collectNoticeDeliveryChannels();
    if (!delivery_channels) return alert('Select at least one delivery channel.');

    let block_filters = null;
    if (audience === 'BLOCKS') {
        block_filters = [...document.querySelectorAll('.notice-block-chip.active')]
            .map((c) => c.dataset.block)
            .filter(Boolean);
        if (!block_filters.length) {
            return alert('Select at least one block, or choose "All residents".');
        }
    }

    const expires_at = expiresRaw ? new Date(`${expiresRaw}T23:59:59`).toISOString() : null;

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('society_notices').insert({
        id: crypto.randomUUID(),
        apartment_id,
        title,
        body,
        priority,
        audience,
        block_filters,
        expires_at,
        delivery_channels,
        created_by: user?.id,
    });
    if (error) return alert(error.message);
    await pullState();
    closeNoticeComposer();
    noticeFilter = 'draft';
    renderNoticesAdmin();
};

export const initNotices = () => {
    initNoticeEditor();
    document.getElementById('notice-add-btn')?.addEventListener('click', openNoticeComposer);
    document.getElementById('notice-back-btn')?.addEventListener('click', closeNoticeComposer);
    bindBusyClick(document.getElementById('notice-save-btn'), 'Publishing…', saveNotice);
    document.getElementById('notice-cancel-btn')?.addEventListener('click', closeNoticeComposer);
    document.getElementById('notice-audience')?.addEventListener('change', syncAudiencePanel);

    document.querySelectorAll('#notice-filters [data-notice-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
            noticeFilter = btn.dataset.noticeFilter || 'all';
            renderNoticesAdmin();
        });
    });

    document.getElementById('notice-priority-pills')?.addEventListener('click', (e) => {
        const pill = e.target.closest('.notice-priority-pill');
        if (pill?.dataset.priority) setPriority(pill.dataset.priority);
    });
};
