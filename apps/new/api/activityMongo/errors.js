export class ActivityHttpError extends Error {
    constructor(message, { status = 400, code = 'activity_error' } = {}) {
        super(message);
        this.name = 'ActivityHttpError';
        this.status = status;
        this.code = code;
    }
}

export function badRequest(message, code = 'validation_error') {
    return new ActivityHttpError(message, { status: 400, code });
}
