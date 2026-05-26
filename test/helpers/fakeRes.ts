import type { ServerResponse } from 'node:http';

export class FakeRes {
  chunks: string[] = [];
  headers: Record<string, string | number> = {};
  statusCode = 0;
  ended = false;

  setHeader(key: string, value: string | number): void {
    this.headers[key.toLowerCase()] = value;
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    }
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }

  get body(): string {
    return this.chunks.join('');
  }

  /** Cast to ServerResponse for code that only uses the methods above. */
  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}
