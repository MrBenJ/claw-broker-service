import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { RoomRegistry } from './rooms.js';
import { sendJson, setCorsHeaders } from './sse.js';
import { validatePeerAndRoom, validateRoom, validateSignalEnvelope } from './validation.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface SignalingService {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  closeAllSubscribers: () => void;
  readonly subscriberCount: number;
}

export function createSignalingService(config: Config): SignalingService {
  const registry = new RoomRegistry(
    config.maxSubscribersPerRoom,
    config.maxSubscribersTotal,
    config.pingIntervalMs,
  );

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/subscribe') {
      handleSubscribe(req, res, url, registry, config);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/signal') {
      void handleSignal(req, res, url, registry, config);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  };

  return {
    handler,
    closeAllSubscribers: () => registry.closeAll(),
    get subscriberCount() {
      return registry.subscriberCount;
    },
  };
}

function handleSubscribe(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: RoomRegistry,
  config: Config,
): void {
  const peerId = url.searchParams.get('id')?.trim();
  const room = url.searchParams.get('room')?.trim();

  const paramError = validatePeerAndRoom(peerId, room, config.maxIdLength, config.maxRoomLength);
  if (paramError) {
    sendJson(res, paramError.status, { error: paramError.message });
    return;
  }
  const capError = registry.checkCapacity(room!);
  if (capError) {
    sendJson(res, capError.status, { error: capError.message });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders?.();

  const connId = registry.add(peerId!, room!, res);
  res.once('close', () => registry.remove(room!, connId));
}

async function handleSignal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: RoomRegistry,
  config: Config,
): Promise<void> {
  const room = url.searchParams.get('room')?.trim();
  const roomError = validateRoom(room, config.maxRoomLength);
  if (roomError) {
    sendJson(res, roomError.status, { error: roomError.message });
    return;
  }

  let envelope;
  try {
    envelope = validateSignalEnvelope(await readJsonBody(req), config.maxIdLength);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));

  registry.fanOutSignal(room!, envelope);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_JSON_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new Error('Missing JSON body');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body');
  }
}
