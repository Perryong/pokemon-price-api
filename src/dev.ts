import { createServer } from 'node:http';
import handler from './handler.js';
const port = Number(process.env.PORT ?? 3001);
createServer((req, res) => {
  void handler(req, res).catch(() => {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  });
}).listen(port, '127.0.0.1', () => console.log(`Price API: http://127.0.0.1:${port}/api/market/health`));
