const MAX_BODY = 1024 * 1024;
export async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BODY || !response.body) throw new Error('Invalid body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) throw new Error('Oversized body');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
