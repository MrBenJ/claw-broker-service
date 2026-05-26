export interface ValidationError {
  status: number;
  message: string;
}

export interface SignalEnvelope {
  from: string;
  to: string;
  data: unknown;
}

export function validateRoom(room: string | undefined, maxRoomLength: number): ValidationError | null {
  if (!room) return { status: 400, message: 'Missing room' };
  if (room.length > maxRoomLength) return { status: 413, message: 'room is too long' };
  return null;
}

export function validatePeerAndRoom(
  peerId: string | undefined,
  room: string | undefined,
  maxIdLength: number,
  maxRoomLength: number,
): ValidationError | null {
  if (!peerId || !room) return { status: 400, message: 'Missing id or room' };
  if (peerId.length > maxIdLength) return { status: 413, message: 'id is too long' };
  return validateRoom(room, maxRoomLength);
}

export function validateSignalEnvelope(value: unknown, maxIdLength: number): SignalEnvelope {
  // Mirror the reference exactly: typeof null/string/number !== 'object', but
  // arrays ARE objects and fall through to the from/to checks below.
  if (!value || typeof value !== 'object') {
    throw new Error('Signal body must be a JSON object');
  }
  const body = value as { from?: unknown; to?: unknown; data?: unknown };
  if (typeof body.from !== 'string' || !body.from.trim()) {
    throw new Error('Signal body missing from');
  }
  if (typeof body.to !== 'string' || !body.to.trim()) {
    throw new Error('Signal body missing to');
  }
  const from = body.from.trim();
  const to = body.to.trim();
  if (from.length > maxIdLength) throw new Error('Signal body from is too long');
  if (to.length > maxIdLength) throw new Error('Signal body to is too long');
  return { from, to, data: body.data ?? {} };
}
