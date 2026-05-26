import { describe, expect, it } from 'vitest';
import { sendJson, setCorsHeaders, writeSse } from '../src/sse.js';
import { FakeRes } from './helpers/fakeRes.js';

describe('writeSse', () => {
  it('frames a single-line event', () => {
    const res = new FakeRes();
    writeSse(res.asResponse(), 'announce', 'peer-a');
    expect(res.body).toBe('event: announce\ndata: peer-a\n\n');
  });

  it('emits one data line per source line for multi-line payloads', () => {
    const res = new FakeRes();
    writeSse(res.asResponse(), 'signal', 'a\nb');
    expect(res.body).toBe('event: signal\ndata: a\ndata: b\n\n');
  });
});

describe('setCorsHeaders', () => {
  it('sets the wide CORS policy', () => {
    const res = new FakeRes();
    setCorsHeaders(res.asResponse());
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type,Accept');
  });
});

describe('sendJson', () => {
  it('writes status, content-type, and serialized body', () => {
    const res = new FakeRes();
    sendJson(res.asResponse(), 200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toBe('{"ok":true}');
    expect(res.ended).toBe(true);
  });
});
