import type { IncomingMessage, ServerResponse } from 'node:http';
import { marketMiddleware } from './market.js';
const market = marketMiddleware();
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await market(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
