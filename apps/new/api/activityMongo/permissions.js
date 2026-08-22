/** Society-wide activity trail — same audience as classic audit log. */
export const ACTIVITY_READ_PERMS = [
    'accounts.view',
    'accounts.edit',
    'setup.view',
    'setup.edit',
    'rbac.view',
    'rbac.edit',
];

export const ACTIVITY_WRITE_PERMS = ACTIVITY_READ_PERMS;
