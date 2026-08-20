import { portalState } from './store.js';

async function rbacMongoPost(body) {
    const apartment_id = body.apartment_id || portalState.access?.activeApartmentId;
    const res = await fetch('/api/rbac-mongo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, apartment_id }),
    });
    let json = {};
    try {
        json = await res.json();
    } catch { /* ignore */ }
    if (!res.ok) {
        throw new Error(json.error || 'Could not save RBAC to Mongo.');
    }
    return json;
}

export async function persistMongoAssignment({ userId, apartmentId, roleKey, email, fullName }) {
    await rbacMongoPost({
        action: 'saveAssignment',
        apartment_id: apartmentId,
        user_id: userId,
        role_key: roleKey,
        email,
        full_name: fullName,
    });
}

export async function persistMongoPolicy({ apartmentId, pages, modules, crud }) {
    return rbacMongoPost({
        action: 'savePolicy',
        apartment_id: apartmentId,
        pages,
        modules,
        crud,
    });
}
