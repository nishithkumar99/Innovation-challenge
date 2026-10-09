/** Runtime settings from /config.js (see public/config.js). Missing file or fields fall back to the demo defaults. */
interface SclRuntime { backend?: 'mock' | 'real'; apiBase?: string; wsUrl?: string; }

const raw: SclRuntime = (globalThis as { __SCL__?: SclRuntime }).__SCL__ ?? {};

export const RUNTIME = {
  /** true = in-browser mock fleet, false = Java/Spring Boot core. */
  useMock: raw.backend !== 'real',
  apiBase: raw.apiBase || '/api',
  /** Empty = same origin as the page ('/ws'). */
  wsUrl: raw.wsUrl || '',
} as const;
