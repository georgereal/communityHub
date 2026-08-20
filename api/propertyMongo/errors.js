export class PropertyHttpError extends Error {
    constructor(message, { status = 400, code = 'property_error' } = {}) {
        super(message);
        this.name = 'PropertyHttpError';
        this.status = status;
        this.code = code;
    }
}

export function badRequest(message, code = 'validation_error') {
    return new PropertyHttpError(message, { status: 400, code });
}

export function notFound(message = 'Not found') {
    return new PropertyHttpError(message, { status: 404, code: 'not_found' });
}
