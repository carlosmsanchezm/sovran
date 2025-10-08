import { describe, expect, test } from '@jest/globals';
import net, { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { ConnectionManager } from '../../connection';

describe('ConnectionManager', () => {
  async function createServer(handler?: (ws: import('ws').WebSocket) => void) {
    const httpServer = http.createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { port } = httpServer.address() as AddressInfo;
    const server = new WebSocketServer({ server: httpServer });
    if (handler) {
      server.on('connection', handler);
    }
    return {
      port,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    };
  }

  async function getUnusedPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(port);
        });
      });
    });
  }

  async function expectRejectWithin<T>(promiseFactory: () => PromiseLike<T>, timeoutMs: number) {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
      Promise.resolve(promiseFactory()).then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  test('opens and exchanges messages with metrics updated', async () => {
    const received: Buffer[] = [];
    const { port, close } = await createServer((socket) => {
      socket.on('message', (data) => {
        const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
        received.push(buf);
        socket.send(buf);
      });
    });
    const connection = new ConnectionManager(`ws://127.0.0.1:${port}`, {
      heartbeatIntervalMs: 100,
      idleTimeoutMs: 1000,
      logLevel: 'trace',
      log: () => {},
      rejectUnauthorized: false,
    });

    try {
      const transport = await connection.open();

      const echoed = await new Promise<Uint8Array>((resolve) => {
        transport.onDidReceiveMessage((payload) => resolve(payload));
        transport.send(new Uint8Array([1, 2, 3]));
      });

      expect(Array.from(echoed)).toEqual([1, 2, 3]);
      expect(received).toHaveLength(1);
      expect(Array.from(received[0])).toEqual([1, 2, 3]);

      const metrics = connection.getMetrics();
      expect(metrics.bytesTx).toBe(3);
      expect(metrics.bytesRx).toBe(3);
      expect(metrics.lastMessageAt).toBeDefined();

      const closed = new Promise<void>((resolve) => transport.onDidClose(() => resolve()));
      transport.end();
      await closed;
    } finally {
      await close();
    }
  });

  test('sends pings and updates lastHeartbeatAt / lastMessageAt', async () => {
    const { port, close } = await createServer((socket) => {
      socket.on('ping', () => socket.pong());
      socket.on('message', (data) => socket.send(data));
    });

    const connection = new ConnectionManager(`ws://127.0.0.1:${port}`, {
      heartbeatIntervalMs: 100,
      idleTimeoutMs: 2000,
      logLevel: 'trace',
      log: () => {},
      rejectUnauthorized: false,
    });

    try {
      const transport = await connection.open();

      await new Promise((resolve) => setTimeout(resolve, 1200));
      const metricsAfterPing = connection.getMetrics();
      expect(metricsAfterPing.lastHeartbeatAt).toBeDefined();

      const messagePromise = new Promise<void>((resolve) => {
        transport.onDidReceiveMessage(() => resolve());
      });
      transport.send(new Uint8Array([7, 8, 9]));
      await messagePromise;
      const metricsAfterMessage = connection.getMetrics();
      expect(metricsAfterMessage.lastMessageAt).toBeDefined();

      const closed = new Promise<void>((resolve) => transport.onDidClose(() => resolve()));
      transport.end();
      await closed;
    } finally {
      await close();
    }
  });

  test('terminates after idle timeout', async () => {
    const { port, close } = await createServer((socket) => {
      socket.on('ping', () => socket.pong());
    });

    const connection = new ConnectionManager(`ws://127.0.0.1:${port}`, {
      heartbeatIntervalMs: 100,
      idleTimeoutMs: 300,
      logLevel: 'debug',
      log: () => {},
      rejectUnauthorized: false,
    });

    try {
      const transport = await connection.open();
      const closed = new Promise<void>((resolve) => transport.onDidClose(() => resolve()));

      await new Promise((resolve) => setTimeout(resolve, 1500));
      await closed;

      const metrics = connection.getMetrics();
      expect(metrics.lastClose).toBeDefined();
    } finally {
      await close();
    }
  });

  test('propagates connection errors during connecting', async () => {
    const port = await getUnusedPort();
    const connection = new ConnectionManager(`ws://127.0.0.1:${port}`, {
      heartbeatIntervalMs: 100,
      idleTimeoutMs: 1000,
      logLevel: 'debug',
      log: () => {},
      rejectUnauthorized: false,
    });

    await expect(expectRejectWithin(() => connection.open(), 5000)).rejects.toThrow();
    const metrics = connection.getMetrics();
    expect(metrics.lastError).toBeDefined();
  });
});
