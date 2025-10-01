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
wss.on('connection', (ws, req) => {
    console.log(`[proxy] WebSocket connection established.`);
    const sock = net.createConnection({ host: ECHO_SERVER_HOST, port: ECHO_SERVER_PORT });
    const pingInterval = setInterval(() => ws.ping(), 15000);
    ws.on('message', (data) => {
        const buf = data instanceof Buffer ? data : Buffer.from(data);
        console.log(`[proxy] C->S: ${buf.length} bytes`);
        sock.write(buf);
    });
    sock.on('data', (chunk) => {
        console.log(`[proxy] S->C: ${chunk.length} bytes`);
        if (ws.readyState === ws.OPEN) {
            ws.send(chunk);
        }
    });
    const closeAll = (why) => {
        clearInterval(pingInterval);
        sock.destroy();
        ws.close();
        console.log(`[proxy] Connection closed: ${why}`);
    };
    ws.on('close', () => closeAll('ws-close'));
    ws.on('error', (e) => closeAll(`ws-error: ${e.message}`));
    sock.on('error', (e) => closeAll(`tcp-error: ${e.message}`));
    sock.on('close', () => closeAll('tcp-close'));
});
server.listen(7001, '127.0.0.1', () => console.log(`[proxy] WSS listening on https://127.0.0.1:7001/tunnel`));
