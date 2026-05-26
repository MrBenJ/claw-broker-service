import type { ServerResponse } from 'node:http';

export function writeSse(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\n`);
  for (const line of data.split('\n')) res.write(`data: ${line}\n`);
  res.write('\n');
}

export function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
