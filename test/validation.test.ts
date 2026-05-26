import { describe, expect, it } from 'vitest';
import {
  validatePeerAndRoom,
  validateRoom,
  validateSignalEnvelope,
} from '../src/validation.js';

describe('validatePeerAndRoom', () => {
  it('passes for valid values', () => {
    expect(validatePeerAndRoom('peer', 'room', 128, 256)).toBeNull();
  });
  it('flags missing id or room', () => {
    expect(validatePeerAndRoom('', 'room', 128, 256)).toEqual({ status: 400, message: 'Missing id or room' });
    expect(validatePeerAndRoom('peer', '', 128, 256)).toEqual({ status: 400, message: 'Missing id or room' });
    expect(validatePeerAndRoom(undefined, undefined, 128, 256)).toEqual({ status: 400, message: 'Missing id or room' });
  });
  it('flags an over-long id', () => {
    expect(validatePeerAndRoom('x'.repeat(9), 'room', 8, 256)).toEqual({ status: 413, message: 'id is too long' });
  });
  it('flags an over-long room', () => {
    expect(validatePeerAndRoom('peer', 'x'.repeat(9), 128, 8)).toEqual({ status: 413, message: 'room is too long' });
  });
});

describe('validateRoom', () => {
  it('passes for a valid room', () => {
    expect(validateRoom('room', 256)).toBeNull();
  });
  it('flags a missing room', () => {
    expect(validateRoom('', 256)).toEqual({ status: 400, message: 'Missing room' });
    expect(validateRoom(undefined, 256)).toEqual({ status: 400, message: 'Missing room' });
  });
  it('flags an over-long room', () => {
    expect(validateRoom('x'.repeat(9), 8)).toEqual({ status: 413, message: 'room is too long' });
  });
});

describe('validateSignalEnvelope', () => {
  it('returns the trimmed envelope and defaults data to {}', () => {
    expect(validateSignalEnvelope({ from: ' a ', to: ' b ' }, 128)).toEqual({ from: 'a', to: 'b', data: {} });
  });
  it('preserves data when present', () => {
    const data = { type: 'offer', sdp: 'v=0' };
    expect(validateSignalEnvelope({ from: 'a', to: 'b', data }, 128)).toEqual({ from: 'a', to: 'b', data });
  });
  it.each([null, 'hi', 42])('rejects non-object body %p', (body) => {
    expect(() => validateSignalEnvelope(body, 128)).toThrow('Signal body must be a JSON object');
  });
  it('treats an array as an object (matching the reference) and then fails on missing from', () => {
    // typeof [] === 'object', so the reference falls through to the from-check.
    expect(() => validateSignalEnvelope([], 128)).toThrow('Signal body missing from');
  });
  it('rejects a missing/empty from', () => {
    expect(() => validateSignalEnvelope({ to: 'b' }, 128)).toThrow('Signal body missing from');
    expect(() => validateSignalEnvelope({ from: '  ', to: 'b' }, 128)).toThrow('Signal body missing from');
  });
  it('rejects a missing/empty to', () => {
    expect(() => validateSignalEnvelope({ from: 'a' }, 128)).toThrow('Signal body missing to');
    expect(() => validateSignalEnvelope({ from: 'a', to: '  ' }, 128)).toThrow('Signal body missing to');
  });
  it('rejects an over-long from', () => {
    expect(() => validateSignalEnvelope({ from: 'x'.repeat(9), to: 'b' }, 8)).toThrow('Signal body from is too long');
  });
  it('rejects an over-long to', () => {
    expect(() => validateSignalEnvelope({ from: 'a', to: 'x'.repeat(9) }, 8)).toThrow('Signal body to is too long');
  });
});
