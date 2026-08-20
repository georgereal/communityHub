/**
 * Typed HTTP errors for the finance Mongo domain layer.
 */
export class FinanceHttpError extends Error {
    constructor(message, { status = 400, code = 'finance_error' } = {}) {
        super(message);
        this.name = 'FinanceHttpError';
        this.status = status;
        this.code = code;
    }
}

export function badRequest(message, code = 'validation_error') {
    return new FinanceHttpError(message, { status: 400, code });
}
