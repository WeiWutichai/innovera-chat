/**
 * Small structured logger. Emits one JSON object per line so the existing log pipeline
 * can parse operational events without a logging framework.
 *
 * Redaction is deliberately conservative: anything whose field name looks like a secret,
 * a credential, or user content is replaced rather than truncated, and string values are
 * additionally scanned for credential-shaped material. Losing a diagnostic field is
 * always preferable to writing a key or a prompt into a log.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const REDACTED = "[redacted]";

// Field names that must never reach a log, whatever they contain.
const SENSITIVE_FIELD =
  /(^|_|\.)(authorization|cookie|password|passwd|secret|token|apikey|api_key|key|credential|dsn|database_url|databaseurl|connection_string|email|prompt|completion|content|messages|answer|body)($|_|\.)/i;

// Credential-shaped values, caught even when the field name looks harmless.
const SENSITIVE_VALUE =
  /(sk_(test|live)_[A-Za-z0-9]{8,}|pk_live_[A-Za-z0-9]{8,}|postgres(ql)?:\/\/[^\s]*:[^\s]*@|Bearer\s+[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactValue);

  if (typeof value === "object") {
    return redactFields(value as LogFields);
  }

  return String(value);
}

function redactFields(fields: LogFields): LogFields {
  const safe: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    safe[key] = SENSITIVE_FIELD.test(key) ? REDACTED : redactValue(value);
  }

  return safe;
}

/**
 * Writes through console so existing transports (and test spies) keep working.
 * `timestamp`, `level` and `event` are always present; `correlationId` when supplied.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redactFields(fields),
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logInfo = (event: string, fields?: LogFields) => logEvent("info", event, fields);
export const logWarn = (event: string, fields?: LogFields) => logEvent("warn", event, fields);
export const logError = (event: string, fields?: LogFields) => logEvent("error", event, fields);

/** Exposed for tests; not used by request handling. */
export const __redactForTest = redactFields;
