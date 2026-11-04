import { type Logger, pino } from "pino";

// Structured JSON logs: one object per line, so Cloud Logging, `kubectl logs | jq` and any
// log tool can filter by field (delivery id, PR, rule) instead of grepping text.
//
// Google Cloud reads `severity` and `message`; pino's defaults are a numeric `level` and `msg`.

const SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export type LogFormat = "json" | "pretty";

export function createLogger(options: { level?: string; format?: LogFormat } = {}): Logger {
  const level = options.level ?? "info";
  if (options.format === "pretty") {
    // Human-readable output for local development (pino-pretty is a dev dependency).
    return pino({ level, transport: { target: "pino-pretty", options: { colorize: true } } });
  }
  return pino({
    level,
    messageKey: "message",
    formatters: { level: (label) => ({ severity: SEVERITY[label] ?? "DEFAULT" }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined, // the platform already records host and process
  });
}

export type { Logger };
