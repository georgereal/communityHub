/**
 * Resident portal — link auth users to flats; manual admin link + email invites
 */
import { portalState, supabase, pullState } from './store.js';
import { loadResidents, normUnit, isValidEmail } from './residents.js';
import { renderPortalSubview } from './residentPortal.js';
import { queueEmail } from './emailOutbox.js';

const canManageLinks = () => {
    const role = portalState.auth?.role
        || portalState.access?.users?.find((u) => u.id === portalState.auth?.id)?.role;
    return ['admin', 'property_manager', 'accounts_manager'].includes(role);
};

export const getLinksForApartment = () => portalState.portal?.residentLinks || [];
export const getInvitesForApartment = () => portalState.portal?.portalInvites || [];

const residentName = (r) => r?.full_name || r?.name || 'Resident';

function residentLabel(r) {
    return `${r.unit_number || '—'} — ${residentName(r)}${r.email ? ` (${r.email})` : ''}`;
}

async function resolveUserIdByEmail(email) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const local = portalState.access.users.find((u) => (u.email || '').trim().toLowerCase() === normalized);
    if (local) return local.id;
    if (!supabase) return null;
    const { data } = await supabase.from('profiles').select('id').eq('email', normalized).maybeSingle();
    return data?.id || null;
}

export async function linkUserToResident(userId, residentId, { verified = true } = {}) {
    if (!supabase) throw new Error('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id || !userId || !residentId) throw new Error('Missing link details.');

    const existing = getLinksForApartment().some(
        (l) => l.user_id === userId && l.resident_id === residentId,
    );
    if (existing) return { alreadyLinked: true };

    const { error } = await supabase.from('resident_user_links').insert({
        id: crypto.randomUUID(),
        apartment_id,
        resident_id: residentId,
        user_id: userId,
        verified_at: verified ? new Date().toISOString() : null,
    });
    if (error) {
        if (error.code === 'PGRST205' || /resident_user_links/.test(error.message || '')) {
            throw new Error('Database table resident_user_links is missing. Run supabase_phase3_portal_bundle.sql in Supabase SQL Editor.');
        }
        throw error;
    }
    await pullState();
    return { linked: true };
}

export async function unlinkResidentUserLink(linkId) {
    if (!supabase) throw new Error('Supabase required.');
    const { error } = await supabase.from('resident_user_links').delete().eq('id', linkId);
    if (error) throw error;
    await pullState();
}

/** Admin: link an existing account to a resident / flat immediately */
export async function adminManualLinkAccount({ residentId, userId, userEmail }) {
    if (!canManageLinks()) throw new Error('You do not have permission to link accounts.');
    let targetUserId = userId;
    if (!targetUserId && userEmail) {
        targetUserId = await resolveUserIdByEmail(userEmail);
        if (!targetUserId) {
            throw new Error('No account found for that email. Send an email invitation instead.');
        }
    }
    if (!targetUserId || !residentId) throw new Error('Select a resident and user account.');
    return linkUserToResident(targetUserId, residentId);
}

/** Admin: update resident email, create pending invite, queue invitation email */
export async function sendPortalInvite({ residentId, email }) {
    if (!canManageLinks()) throw new Error('You do not have permission to send invites.');
    if (!supabase) throw new Error('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    const normalized = email?.trim().toLowerCase();
    if (!residentId || !normalized) throw new Error('Resident and email are required.');
    if (!isValidEmail(normalized)) throw new Error('Invalid email address.');

    const residents = await loadResidents(true);
    const resident = residents.find((r) => r.id === residentId);
    if (!resident) throw new Error('Resident not found.');

    const { data: { user } } = await supabase.auth.getUser();
    const societyName = portalState.community?.name || 'your society';
    const flat = resident.unit_number || 'your flat';
    const signupUrl = `${window.location.origin}${window.location.pathname}`;

    if (!(resident.email || '').trim()) {
        const { error: updErr } = await supabase.from('residents')
            .update({ email: normalized })
            .eq('id', residentId);
        if (updErr) throw new Error(updErr.message);
    }

    const existingInvite = getInvitesForApartment().find(
        (i) => i.resident_id === residentId && i.email.toLowerCase() === normalized && i.status === 'PENDING',
    );
    if (!existingInvite) {
        const { error: invErr } = await supabase.from('resident_portal_invites').insert({
            id: crypto.randomUUID(),
            apartment_id,
            resident_id: residentId,
            email: normalized,
            invited_by: user?.id,
        });
        if (invErr) throw new Error(invErr.message);
    }

    const subject = `You're invited to ${societyName} Resident Portal`;
    const body = `Hello ${residentName(resident)},\n\n`
        + `You have been invited to access the Resident Portal for flat ${flat} at ${societyName}.\n\n`
        + `1. Sign up or sign in at: ${signupUrl}\n`
        + `2. Use this email address: ${normalized}\n`
        + `3. Open Resident Portal → Home — your flat will link automatically.\n\n`
        + `If you already have an account with a different email, contact the society office.\n\n`
        + `— ${societyName}`;

    await queueEmail({
        recipient_email: normalized,
        subject,
        body,
        template_key: 'portal_invite',
        related_entity_type: 'resident',
        related_entity_id: residentId,
    });

    await pullState();
    return { invited: true, email: normalized, flat };
}

export async function revokePortalInvite(inviteId) {
    if (!supabase) throw new Error('Supabase required.');
    const { error } = await supabase.from('resident_portal_invites')
        .update({ status: 'REVOKED' })
        .eq('id', inviteId);
    if (error) throw error;
    await pullState();
}

/** On login: accept pending invites matching user email → create links */
export async function acceptPendingInvites() {
    if (!supabase) return { linked: 0 };
    const uid = portalState.auth?.id;
    const email = (portalState.auth?.email || '').trim().toLowerCase();
    if (!uid || !email) return { linked: 0 };

    const pending = getInvitesForApartment().filter(
        (i) => i.status === 'PENDING' && i.email.toLowerCase() === email,
    );
    if (!pending.length) return { linked: 0 };

    let linked = 0;
    for (const invite of pending) {
        const res = await linkUserToResident(uid, invite.resident_id);
        if (res.linked || res.alreadyLinked) {
            await supabase.from('resident_portal_invites')
                .update({ status: 'ACCEPTED', accepted_at: new Date().toISOString() })
                .eq('id', invite.id);
            if (res.linked) linked += 1;
        }
    }
    if (linked) await pullState();
    return { linked };
}

export async function autoLinkResidentByEmail() {
    if (!supabase) return { linked: 0 };
    const uid = portalState.auth?.id;
    const email = (portalState.auth?.email || '').trim().toLowerCase();
    const apartmentId = portalState.access?.activeApartmentId;
    if (!uid || !email || !apartmentId) return { linked: 0 };

    const inviteRes = await acceptPendingInvites();
    if (inviteRes.linked) return { linked: inviteRes.linked, message: `Linked ${inviteRes.linked} flat(s) from your invitation.` };

    const residents = await loadResidents(true);
    const matches = residents.filter((r) => (r.email || '').trim().toLowerCase() === email);
    if (!matches.length) return { linked: 0, message: 'No resident record with your email.' };

    const existing = getLinksForApartment().filter((l) => l.user_id === uid);
    let linked = 0;
    for (const r of matches) {
        if (existing.some((l) => l.resident_id === r.id)) continue;
        await linkUserToResident(uid, r.id);
        linked += 1;
    }
    return { linked, message: linked ? `Linked ${linked} flat(s).` : 'Already linked.' };
}

export async function linkMyFlatByUnit(unitNumber) {
    if (!supabase) throw new Error('Supabase required.');
    const uid = portalState.auth?.id;
    const email = (portalState.auth?.email || '').trim().toLowerCase();
    const target = normUnit(unitNumber);
    if (!uid || !target) throw new Error('Enter a flat number.');

    const inviteRes = await acceptPendingInvites();
    if (inviteRes.linked) return { linked: inviteRes.linked, message: `Linked flat ${target} from your invitation.` };

    const residents = await loadResidents(true);
    const matches = residents.filter(
        (r) => normUnit(r.unit_number) === target && (r.email || '').trim().toLowerCase() === email,
    );
    if (!matches.length) {
        throw new Error('No resident on that flat with your login email. Ask the office to link you or send an invite.');
    }

    let linked = 0;
    for (const r of matches) {
        const res = await linkUserToResident(uid, r.id);
        if (res.linked) linked += 1;
    }
    return { linked, message: linked ? `Linked flat ${target}.` : 'Flat already linked.' };
}

function populateFlatSelect(selectEl, residents, selectedUnit = '') {
    if (!selectEl) return;
    const units = [...new Set(residents.map((r) => normUnit(r.unit_number)).filter(Boolean))].sort();
    selectEl.innerHTML = `<option value="">— Select flat —</option>${units.map((u) =>
        `<option value="${u}" ${u === normUnit(selectedUnit) ? 'selected' : ''}>${u}</option>`,
    ).join('')}`;
}

function populateResidentSelect(selectEl, residents, unitFilter = '', selectedId = '') {
    if (!selectEl) return;
    const filtered = unitFilter
        ? residents.filter((r) => normUnit(r.unit_number) === normUnit(unitFilter))
        : residents;
    selectEl.innerHTML = filtered
        .sort((a, b) => String(a.unit_number).localeCompare(String(b.unit_number)))
        .map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${residentLabel(r)}</option>`)
        .join('');
}

function setLinkModalMode(mode) {
    document.querySelectorAll('[data-link-mode]').forEach((btn) => {
        btn.classList.toggle('resident-link-tab--active', btn.dataset.linkMode === mode);
    });
    document.getElementById('resident-link-panel-manual')?.toggleAttribute('hidden', mode !== 'manual');
    document.getElementById('resident-link-panel-invite')?.toggleAttribute('hidden', mode !== 'invite');
}

export const renderResidentLinksAdmin = async () => {
    const list = document.getElementById('resident-links-list');
    if (!list) return;
    if (!canManageLinks()) {
        list.innerHTML = '<p class="admin-hint">You do not have permission to manage portal links.</p>';
        try {
            const { setPendingInviteAttention } = await import('./setupSocietyUi.js');
            setPendingInviteAttention(0);
        } catch { /* ignore */ }
        return;
    }

    const residents = await loadResidents(true);
    const residentById = new Map(residents.map((r) => [r.id, r]));
    const userById = new Map(portalState.access.users.map((u) => [u.id, u]));
    const links = getLinksForApartment();
    const invites = getInvitesForApartment().filter((i) => i.status === 'PENDING');

    const linksHtml = links.length ? `
      <div class="resident-links-table">
        <div class="resident-links-table__head">
          <span>User</span>
          <span>Flat / Resident</span>
          <span>Linked</span>
          <span></span>
        </div>
        ${links.map((l) => {
            const user = userById.get(l.user_id);
            const resident = residentById.get(l.resident_id);
            return `<div class="resident-links-table__row">
              <div>
                <strong>${user?.name || user?.email || l.user_id.slice(0, 8)}</strong>
                <span class="resident-links-table__sub">${user?.email || ''}</span>
              </div>
              <div>
                <strong>${resident?.unit_number || '—'}</strong>
                <span class="resident-links-table__sub">${residentName(resident)}</span>
              </div>
              <span>${l.verified_at ? new Date(l.verified_at).toLocaleDateString('en-IN') : '—'}</span>
              <button type="button" class="btn-icon danger resident-link-unlink" data-link-id="${l.id}" title="Remove link">
                <i class="fa-solid fa-link-slash"></i>
              </button>
            </div>`;
        }).join('')}
      </div>` : '<p class="admin-hint">No active portal links.</p>';

    const invitesHtml = invites.length ? `
      <h4 class="resident-links-subtitle">Pending email invitations</h4>
      <div class="resident-links-table resident-links-table--invites">
        <div class="resident-links-table__head">
          <span>Email</span>
          <span>Flat / Resident</span>
          <span>Sent</span>
          <span></span>
        </div>
        ${invites.map((i) => {
            const resident = residentById.get(i.resident_id);
            return `<div class="resident-links-table__row">
              <div><strong>${i.email}</strong></div>
              <div>
                <strong>${resident?.unit_number || '—'}</strong>
                <span class="resident-links-table__sub">${residentName(resident)}</span>
              </div>
              <span>${new Date(i.created_at).toLocaleDateString('en-IN')}</span>
              <button type="button" class="btn-icon danger resident-invite-revoke" data-invite-id="${i.id}" title="Revoke invite">
                <i class="fa-solid fa-ban"></i>
              </button>
            </div>`;
        }).join('')}
      </div>` : '';

    list.innerHTML = linksHtml + invitesHtml;

    try {
        const { setPendingInviteAttention } = await import('./setupSocietyUi.js');
        setPendingInviteAttention(invites.length);
    } catch { /* ignore */ }

    list.querySelectorAll('.resident-link-unlink').forEach((btn) => {
        btn.onclick = async () => {
            if (!confirm('Remove this portal link?')) return;
            try {
                await unlinkResidentUserLink(btn.dataset.linkId);
                await renderResidentLinksAdmin();
            } catch (err) {
                alert(err.message || 'Could not remove link.');
            }
        };
    });

    list.querySelectorAll('.resident-invite-revoke').forEach((btn) => {
        btn.onclick = async () => {
            if (!confirm('Revoke this invitation?')) return;
            try {
                await revokePortalInvite(btn.dataset.inviteId);
                await renderResidentLinksAdmin();
            } catch (err) {
                alert(err.message || 'Could not revoke invite.');
            }
        };
    });
};

window.openResidentLinkModal = async (userId = null, email = '', residentId = null, mode = 'manual') => {
    const modal = document.getElementById('resident-link-modal');
    if (!modal) return;

    const residents = await loadResidents(true);
    const resident = residentId ? residents.find((r) => r.id === residentId) : null;

    populateFlatSelect(document.getElementById('resident-link-flat'), residents, resident?.unit_number || '');
    populateFlatSelect(document.getElementById('resident-invite-flat'), residents, resident?.unit_number || '');
    populateResidentSelect(
        document.getElementById('resident-link-resident'),
        residents,
        resident?.unit_number || document.getElementById('resident-link-flat')?.value,
        residentId || '',
    );
    populateResidentSelect(
        document.getElementById('resident-invite-resident'),
        residents,
        resident?.unit_number || '',
        residentId || '',
    );

    const userSel = document.getElementById('resident-link-user');
    if (userSel) {
        userSel.innerHTML = `<option value="">— Select account —</option>${portalState.access.users
            .map((u) => `<option value="${u.id}">${u.name || u.email} (${u.email || 'no email'})</option>`)
            .join('')}`;
        if (userId) userSel.value = userId;
    }

    const emailInput = document.getElementById('resident-link-email');
    const inviteEmail = document.getElementById('resident-invite-email');
    if (emailInput) emailInput.value = email || '';
    if (inviteEmail) inviteEmail.value = email || resident?.email || '';

    setLinkModalMode(mode);
    modal.classList.add('active');
};

window.closeResidentLinkModal = () => {
    document.getElementById('resident-link-modal')?.classList.remove('active');
};

export const initResidentLinks = () => {
    document.querySelectorAll('[data-link-mode]').forEach((btn) => {
        btn.addEventListener('click', () => setLinkModalMode(btn.dataset.linkMode));
    });

    document.getElementById('resident-link-flat')?.addEventListener('change', async (e) => {
        const residents = await loadResidents(true);
        populateResidentSelect(document.getElementById('resident-link-resident'), residents, e.target.value);
    });

    document.getElementById('resident-invite-flat')?.addEventListener('change', async (e) => {
        const residents = await loadResidents(true);
        populateResidentSelect(document.getElementById('resident-invite-resident'), residents, e.target.value);
        const picked = residents.find((r) => r.id === document.getElementById('resident-invite-resident')?.value);
        const emailEl = document.getElementById('resident-invite-email');
        if (emailEl && picked?.email && !emailEl.value) emailEl.value = picked.email;
    });

    document.getElementById('resident-invite-resident')?.addEventListener('change', async (e) => {
        const residents = await loadResidents(true);
        const picked = residents.find((r) => r.id === e.target.value);
        const emailEl = document.getElementById('resident-invite-email');
        if (emailEl && picked?.email && !emailEl.value) emailEl.value = picked.email;
    });

    document.getElementById('resident-link-save')?.addEventListener('click', async () => {
        const residentId = document.getElementById('resident-link-resident')?.value;
        const userId = document.getElementById('resident-link-user')?.value;
        const email = document.getElementById('resident-link-email')?.value?.trim();
        try {
            await adminManualLinkAccount({ residentId, userId: userId || null, userEmail: email });
            window.closeResidentLinkModal();
            await renderResidentLinksAdmin();
            alert('Portal link created.');
        } catch (err) {
            alert(err.message || 'Could not create link.');
        }
    });

    document.getElementById('resident-invite-send')?.addEventListener('click', async () => {
        const residentId = document.getElementById('resident-invite-resident')?.value;
        const email = document.getElementById('resident-invite-email')?.value?.trim();
        try {
            const res = await sendPortalInvite({ residentId, email });
            window.closeResidentLinkModal();
            await renderResidentLinksAdmin();
            alert(`Invitation queued for ${res.email} (flat ${res.flat}). Process email outbox in test mode or via Resend.`);
        } catch (err) {
            alert(err.message || 'Could not send invitation.');
        }
    });

    document.getElementById('resident-link-cancel')?.addEventListener('click', () => window.closeResidentLinkModal());

    document.getElementById('view-portal')?.addEventListener('click', async (e) => {
        if (e.target.closest('#portal-link-email-btn')) {
            const res = await autoLinkResidentByEmail();
            alert(res.message || (res.linked ? `Linked ${res.linked} flat(s).` : 'No matching resident email or invitation found.'));
            if (res.linked) void renderPortalSubview('home');
            return;
        }
        if (e.target.closest('#portal-link-unit-btn')) {
            const unit = document.getElementById('portal-link-unit')?.value;
            try {
                const res = await linkMyFlatByUnit(unit);
                alert(res.message);
                if (res.linked) void renderPortalSubview('home');
            } catch (err) {
                alert(err.message);
            }
        }
    });
};
