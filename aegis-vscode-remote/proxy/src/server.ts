import { createServer } from 'https';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import * as net from 'net';

// NOTE: In a real environment, you'd handle certificate paths better.
const CERT = readFileSync('cert.crt');
const KEY = readFileSync('cert.key');

const ECHO_SERVER_HOST = '127.0.0.1';
const ECHO_SERVER_PORT = 11111;

const server = createServer({ cert: CERT, key: KEY });
const wss = new WebSocketServer({ server, path: '/tunnel' });

server.on('request', (req, res) => {
  if (!req.url) {
    res.writeHead(400).end();
    return;
  }

  if (req.url.startsWith('/admin/close')) {
    let closed = 0;
    wss.clients.forEach((client) => {
      closed += 1;
      client.close(4000, 'admin-close');
    });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`closed ${closed} clients\n`);
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  res.writeHead(404).end();
});

wss.on('connection', (ws, req) => {
  console.log(`[proxy] WebSocket connection established.`);

  const url = new URL(req.url ?? '/tunnel', 'https://127.0.0.1');
  const dropAfterMs = Number(url.searchParams.get('dropAfterMs') || 0);

  const sock = net.createConnection({ host: ECHO_SERVER_HOST, port: ECHO_SERVER_PORT });

  const pingInterval = setInterval(() => {
    try {
      ws.ping();
    } catch (err) {
      console.error('[proxy] ping failed', err);
    }
  }, 15000);

  let dropTimer: NodeJS.Timeout | undefined;
  if (dropAfterMs > 0) {
    dropTimer = setTimeout(() => {
      console.log(`[proxy] dropAfterMs triggered (${dropAfterMs}ms)`);
      try {
        ws.close(4001, 'chaos-drop');
      } catch (err) {
        console.error('[proxy] chaos close failed', err);
      }
    }, dropAfterMs);
  }

  let closed = false;
  const closeAll = (why: string) => {
    if (closed) return;
    closed = true;
    clearInterval(pingInterval);
    if (dropTimer) {
      clearTimeout(dropTimer);
    }
    if (!sock.destroyed) {
      sock.destroy();
    }
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, why);
    }
    console.log(`[proxy] Connection closed: ${why}`);
  };

  ws.on('message', (data) => {
    const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
    console.log(`[proxy] C->S: ${buf.length} bytes`);
    sock.write(buf);
  });

  sock.on('data', (chunk) => {
    console.log(`[proxy] S->C: ${chunk.length} bytes`);
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk);
    }
  });

  ws.on('close', (code, reason) => closeAll(`ws-close code=${code} reason=${reason}`));
  ws.on('error', (e) => closeAll(`ws-error: ${e.message}`));
  sock.on('error', (e) => closeAll(`tcp-error: ${e.message}`));
  sock.on('close', () => closeAll('tcp-close'));
});

const shutdown = () => {
  console.log('[proxy] shutting down');
  wss.clients.forEach((client) => client.close(4002, 'proxy-shutdown'));
  wss.close(() => {
    server.close(() => process.exit(0));
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(7001, '127.0.0.1', () =>
  console.log(`[proxy] WSS listening on https://127.0.0.1:7001/tunnel`)
);
