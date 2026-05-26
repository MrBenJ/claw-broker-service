#!/usr/bin/env node
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSignalingService, type SignalingService } from './app.js';
import { loadConfig, type Config } from './config.js';

export interface RunningServer {
  server: http.Server;
  service: SignalingService;
  shutdown: () => Promise<void>;
}

export async function start(config: Config): Promise<RunningServer> {
  const service = createSignalingService(config);
  const server = http.createServer(service.handler);
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

  let closed = false;
  const shutdown = (): Promise<void> => {
    if (closed) return Promise.resolve(); // idempotent: safe to call from a signal and from test teardown
    closed = true;
    return new Promise<void>((resolve, reject) => {
      service.closeAllSubscribers();
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
  };

  return { server, service, shutdown };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, shutdown } = await start(config);
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  console.log(`[broker] listening on http://${config.host}:${port}`);
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    console.log('[broker] localhost-only; front with `tailscale serve` for tailnet HTTPS');
  }

  let shuttingDown = false;
  const onSignal = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[broker] ${sig} received, shutting down`);
    shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[broker] shutdown failed', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
