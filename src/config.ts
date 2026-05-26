export interface Config {
  port: number;
  host: string;
  pingIntervalMs: number;
  maxIdLength: number;
  maxRoomLength: number;
  maxSubscribersPerRoom: number;
  maxSubscribersTotal: number;
}

export const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  pingIntervalMs: 30_000,
  maxIdLength: 128,
  maxRoomLength: 256,
  maxSubscribersPerRoom: 128,
  maxSubscribersTotal: 2048,
} as const;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = env.PORT ?? env.CT_SIGNALING_PORT;
  return {
    port: parsePositiveInt(portRaw, DEFAULTS.port, 'port', 65_535),
    host: env.CT_SIGNALING_HOST?.trim() || DEFAULTS.host,
    pingIntervalMs: parsePositiveInt(env.CT_PING_INTERVAL_MS, DEFAULTS.pingIntervalMs, 'CT_PING_INTERVAL_MS'),
    maxIdLength: parsePositiveInt(env.CT_MAX_ID_LENGTH, DEFAULTS.maxIdLength, 'CT_MAX_ID_LENGTH'),
    maxRoomLength: parsePositiveInt(env.CT_MAX_ROOM_LENGTH, DEFAULTS.maxRoomLength, 'CT_MAX_ROOM_LENGTH'),
    maxSubscribersPerRoom: parsePositiveInt(env.CT_MAX_SUBSCRIBERS_PER_ROOM, DEFAULTS.maxSubscribersPerRoom, 'CT_MAX_SUBSCRIBERS_PER_ROOM'),
    maxSubscribersTotal: parsePositiveInt(env.CT_MAX_SUBSCRIBERS_TOTAL, DEFAULTS.maxSubscribersTotal, 'CT_MAX_SUBSCRIBERS_TOTAL'),
  };
}
