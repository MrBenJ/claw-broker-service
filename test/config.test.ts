import { describe, expect, it } from 'vitest';
import { loadConfig, DEFAULTS } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults for an empty env', () => {
    expect(loadConfig({})).toEqual({
      port: 8787,
      host: '127.0.0.1',
      pingIntervalMs: 30_000,
      maxIdLength: 128,
      maxRoomLength: 256,
      maxSubscribersPerRoom: 128,
      maxSubscribersTotal: 2048,
    });
  });

  it('reads PORT', () => {
    expect(loadConfig({ PORT: '9000' }).port).toBe(9000);
  });

  it('accepts CT_SIGNALING_PORT as an alias for PORT', () => {
    expect(loadConfig({ CT_SIGNALING_PORT: '9001' }).port).toBe(9001);
  });

  it('lets PORT win when both are set', () => {
    expect(loadConfig({ PORT: '9000', CT_SIGNALING_PORT: '9001' }).port).toBe(9000);
  });

  it.each(['0', '70000', 'abc', '-5', '80.5'])('throws on invalid port %s', (bad) => {
    expect(() => loadConfig({ PORT: bad })).toThrow(/Invalid port/);
  });

  it('reads the bind host', () => {
    expect(loadConfig({ CT_SIGNALING_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('allows overriding ping interval and caps', () => {
    const cfg = loadConfig({
      CT_PING_INTERVAL_MS: '25',
      CT_MAX_ID_LENGTH: '8',
      CT_MAX_ROOM_LENGTH: '16',
      CT_MAX_SUBSCRIBERS_PER_ROOM: '2',
      CT_MAX_SUBSCRIBERS_TOTAL: '4',
    });
    expect(cfg).toMatchObject({
      pingIntervalMs: 25,
      maxIdLength: 8,
      maxRoomLength: 16,
      maxSubscribersPerRoom: 2,
      maxSubscribersTotal: 4,
    });
  });

  it('exposes DEFAULTS', () => {
    expect(DEFAULTS.port).toBe(8787);
  });
});
