/** Connections + passbook OCR require accounts edit (same as classic external connections). */
export const INTEGRATIONS_EDIT_PERMS = ['accounts.edit'];

/** Spreadsheet sync boot / read — accounts or setup viewers. */
export const SPREADSHEET_READ_PERMS = ['accounts.view', 'accounts.edit', 'setup.view', 'setup.edit'];

/** Spreadsheet sync write — accounts editors. */
export const SPREADSHEET_EDIT_PERMS = ['accounts.edit'];
