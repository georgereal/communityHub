/** Access requests are not stored in Mongo yet. People directory uses assignments only. */

export function canReviewAccessRequests() {
    return true;
}

export async function fetchPendingAccessRequestsForAdmin() {
    return [];
}

export async function approveAccessRequest() {
    throw new Error('Access requests are not available on New (Mongo). Assign roles from People.');
}

export async function denyAccessRequest() {
    throw new Error('Access requests are not available on New (Mongo).');
}
