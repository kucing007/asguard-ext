const DEBUG_STORAGE_KEY = "asguard.debugLogs";

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /authorization/i,
  /bearer/i,
  /nip/i,
  /nik/i,
  /nama/i,
  /name/i,
  /fullname/i,
  /jabatan/i,
  /payload/i,
  /body/i,
  /pengirim/i,
  /tujuan/i,
  /penandatangan/i,
];

function isDebugEnabled(): boolean {
  try {
    const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
    return g.localStorage?.getItem(DEBUG_STORAGE_KEY) === "1" || g.sessionStorage?.getItem(DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactString(value: string): string {
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return "[redacted-jwt]";
  if (/^\d{9,18}$/.test(value)) return "[redacted-id]";
  if (value.length > 160) return `${value.slice(0, 80)}…[truncated ${value.length} chars]`;
  return value;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[redacted-depth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? "[redacted]" : redact(nested, depth + 1);
  }
  return output;
}

export function debugLog(message: string, ...values: unknown[]): void {
  if (!isDebugEnabled()) return;
  console.log(message, ...values.map((value) => redact(value)));
}

export function safeErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(redact(value));
}
