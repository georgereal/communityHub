export class IntegrationsHttpError extends Error {
    constructor(message, { status = 400, code = 'integrations_error' } = {}) {
        super(message);
        this.name = 'IntegrationsHttpError';
        this.status = status;
        this.code = code;
    }
}

export function badRequest(message, code = 'validation_error') {
    return new IntegrationsHttpError(message, { status: 400, code });
}

export function notFound(message = 'Not found') {
    return new IntegrationsHttpError(message, { status: 404, code: 'not_found' });
}

export function serviceUnavailable(message, code = 'not_configured') {
    return new IntegrationsHttpError(message, { status: 503, code });
}
