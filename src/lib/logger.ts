export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

/** Minimal structured logger that emits one JSON object per line. */
export const consoleLogger: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
  debug: (obj, msg) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(JSON.stringify({ level: 'debug', msg, ...obj }));
    }
  },
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
