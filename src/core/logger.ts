/**
 * Structured JSON logging, one object per line on stderr, with secrets removed before anything is written.
 * Redaction is by field name and by value shape, so a token that ends up in an unexpected field is still caught.
 */
export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const SECRET_KEY = /authorization|api[-_]?key|token|secret|password|passwd|cookie|signature|^sig$|credential/i;
/** Shapes that look like credentials wherever they appear: bearer tokens, Anthropic/OpenAI-style keys, our own keys, signed link parameters. */
const SECRET_VALUE = /(bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,}|hmk_[A-Za-z0-9_-]{16,}|[?&]sig=[A-Za-z0-9_-]{16,})/gi;
const MAX_STRING = 500;

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const clean = value.replace(SECRET_VALUE, (m) => (m.startsWith("?") || m.startsWith("&") ? `${m[0]}sig=[redacted]` : "[redacted]"));
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
  }
  if (value instanceof Error) return redact({ name: value.name, message: value.message, ...(value as { code?: string }).code ? { code: (value as { code?: string }).code } : {} }, depth + 1);
  if (depth > 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return String(value);
}

export interface LoggerOptions {
  level?: Level;
  write?: (line: string) => void;
  now?: () => Date;
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = RANK[opts.level ?? "info"];
  const write = opts.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const now = opts.now ?? (() => new Date());
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
      if (RANK[lvl] < level) return;
      write(JSON.stringify({ time: now().toISOString(), level: lvl, msg: redact(msg), ...(redact({ ...base, ...fields }) as object) }));
    };
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (f) => make({ ...base, ...f }),
    };
  };
  return make(opts.base ?? {});
}

/** Discards everything. The default for the service, so tests and embedders see no output unless they ask for it. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export function levelFromEnv(v: string | undefined): Level {
  const l = (v ?? "info").toLowerCase();
  return l === "debug" || l === "info" || l === "warn" || l === "error" ? l : "info";
}
