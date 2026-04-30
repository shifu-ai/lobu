import type { Readable } from 'node:stream';

export async function readStreamToBuffer(fileStream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of fileStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
