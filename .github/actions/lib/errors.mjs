/** Structured, non-secret-bearing errors shared by HTTP, MCP, and workers. */
export class AppError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export function invariant(ok, code, message, status = 400, details) {
    if (!ok)
        throw new AppError(status, code, message, details);
}
export function publicError(error, requestId) {
    return error instanceof AppError
        ? {
            error: {
                code: error.code,
                message: error.message,
                details: error.details,
                requestId
            }
        }
        : {
            error: {
                code: 'INTERNAL',
                message: 'An internal error occurred. Use the request ID to investigate.',
                requestId
            }
        };
}
/**
 * Secret-value scrubbing for operator logs. A credential's text can reach an error message partially: V8's
 * JSON.parse quotes a prefix of malformed input, header validation may quote a value. Any run of at least
 * FRAGMENT characters shared with a secret is masked, not only whole occurrences. JSON credentials are scrubbed by
 * their string values (field names stay readable); unparseable text is scrubbed by its raw content.
 */
const FRAGMENT = 6;
function secretParts(secrets) {
    const parts = new Set();
    const add = value => {
        if (typeof value !== 'string' || value.length < 4)
            return;
        parts.add(value);
        parts.add(JSON.stringify(value).slice(1, -1));
    };
    const leaves = value => {
        if (typeof value === 'string')
            add(value);
        else if (value && typeof value === 'object')
            Object.values(value).forEach(leaves);
    };
    for (const secret of secrets.flat()) {
        if (typeof secret !== 'string')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(secret);
        }
        catch {
            parsed = undefined;
        }
        if (parsed && typeof parsed === 'object')
            leaves(parsed);
        else
            add(secret);
    }
    return [...parts];
}
export function scrubSecrets(text, secrets = []) {
    const input = String(text ?? '');
    const parts = secretParts(secrets);
    if (!input || !parts.length)
        return input;
    const hidden = new Uint8Array(input.length);
    for (const part of parts) {
        if (part.length < FRAGMENT) {
            for (let at = input.indexOf(part); at !== -1; at = input.indexOf(part, at + 1))
                hidden.fill(1, at, at + part.length);
            continue;
        }
        const windows = new Set();
        for (let i = 0; i + FRAGMENT <= part.length; i++)
            windows.add(part.slice(i, i + FRAGMENT));
        for (let i = 0; i + FRAGMENT <= input.length; i++)
            if (windows.has(input.slice(i, i + FRAGMENT)))
                hidden.fill(1, i, i + FRAGMENT);
    }
    let out = '';
    for (let i = 0; i < input.length; i++)
        if (!hidden[i])
            out += input[i];
        else if (!hidden[i - 1])
            out += '[redacted]';
    return out;
}
/** A copy of `error` whose message, stack and details carry no fragment of `secrets`; status and code are kept. */
export function scrubError(error, secrets = []) {
    if (!secretParts(secrets).length)
        return error;
    if (error instanceof AppError)
        return new AppError(error.status, error.code, scrubSecrets(error.message, secrets), error.details === undefined ? undefined : JSON.parse(scrubSecrets(JSON.stringify(error.details), secrets)));
    const scrubbed = new Error(scrubSecrets(error?.message ?? error, secrets));
    scrubbed.name = typeof error?.name === 'string' ? error.name : 'Error';
    scrubbed.stack = scrubSecrets(error?.stack || '', secrets);
    return scrubbed;
}
/**
 * The only error text that may be persisted into tenant records (releases, plans, tasks, attempts), which release
 * readers, agent tokens and MCP can read. AppErrors carry authored, input-free codes and messages; anything else is
 * replaced by a generic message whose reference ties it to one scrubbed operator log line.
 */
export function safeError(error, { reference, secrets = [], context } = {}) {
    if (error instanceof AppError)
        return { code: error.code, message: error.message };
    const ref = reference || crypto.randomUUID().replaceAll('-', '');
    console.error(JSON.stringify({
        type: 'internal_error',
        context,
        requestId: ref,
        name: typeof error?.name === 'string' ? error.name : undefined,
        message: scrubSecrets(error?.message ?? error, secrets).slice(0, 500),
        stack: scrubSecrets(error?.stack || '', secrets).slice(0, 2000)
    }));
    return { code: 'INTERNAL', message: `Unexpected error (see request ${ref})` };
}
/** A persisted `error` field: the AppError code (the established record shape), otherwise the generic reference text. */
export function safeErrorMessage(error, options) {
    return error instanceof AppError ? error.code : safeError(error, options).message;
}
