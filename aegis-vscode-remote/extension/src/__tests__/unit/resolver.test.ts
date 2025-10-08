import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as resolverModule from '../../resolver';
import { ConnectionManager } from '../../connection';
import * as platform from '../stubs/platform.stub';
import * as config from '../stubs/config.stub';
import { out } from '../stubs/ui.stub';

const { AegisResolver } = resolverModule;

function createEmitter<T>() {
  const listeners: Array<(value: T) => void> = [];
  const event = (listener: (value: T) => any) => {
    listeners.push(listener);
    return {
      dispose: () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) {
          listeners.splice(idx, 1);
        }
      },
    };
  };
  return {
    event,
    fire: (value: T) => {
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
  };
}

describe('AegisResolver', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    (out.appendLine as jest.Mock).mockClear();
  });

  test('builds wss URL with /proxy/<wid> and applies TLS options', async () => {
    jest.spyOn(config, 'getSettings').mockReturnValue({
      heartbeatIntervalMs: 200,
      idleTimeoutMs: 600,
      logLevel: 'debug',
      security: { rejectUnauthorized: true, caPath: '' },
      defaultWorkspaceId: 'fallback',
    });
    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: 'https://127.0.0.1:7443',
      jwt: 'jwt-1',
      ttlSeconds: 0,
    });

    const constructed: Array<{ url: string; opts: any; transport: any }> = [];
    jest.spyOn(ConnectionManager.prototype, 'open').mockImplementation(function (this: any) {
      const closeEmitter = createEmitter<Error | undefined>();
      const endEmitter = createEmitter<void>();
      const transport = {
        onDidReceiveMessage: createEmitter<Uint8Array>().event,
        onDidClose: closeEmitter.event,
        onDidEnd: endEmitter.event,
        send: jest.fn(),
        end: jest.fn(),
      };
      constructed.push({ url: (this as any).url, opts: (this as any).opts, transport });
      return Promise.resolve(transport as any);
    });

    const result = await AegisResolver.resolve('aegis+w-123', { resolveAttempt: 1 } as any);
    await (result as any).opener();

    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('url=wss://127.0.0.1:7443/proxy/w-123'));
    expect(constructed).toHaveLength(1);
    expect(constructed[0].url).toContain('wss://127.0.0.1:7443/proxy/w-123');
    expect(constructed[0].opts.rejectUnauthorized).toBe(true);
    expect(constructed[0].opts.headers.Authorization).toBe('Bearer jwt-1');
  });

  test('adds CA from settings and logs when read fails', async () => {
    const readFileSpy = jest.spyOn(fs.promises, 'readFile');
    jest.spyOn(config, 'getSettings').mockReturnValue({
      heartbeatIntervalMs: 200,
      idleTimeoutMs: 600,
      logLevel: 'debug',
      security: { rejectUnauthorized: false, caPath: '/tmp/ca.pem' },
      defaultWorkspaceId: 'fallback',
    });

    const constructed: Array<{ url: string; opts: any; transport: any }> = [];
    jest.spyOn(ConnectionManager.prototype, 'open').mockImplementation(function (this: any) {
      const closeEmitter = createEmitter<Error | undefined>();
      const endEmitter = createEmitter<void>();
      const transport = {
        onDidReceiveMessage: createEmitter<Uint8Array>().event,
        onDidClose: closeEmitter.event,
        onDidEnd: endEmitter.event,
        send: jest.fn(),
        end: jest.fn(),
      };
      constructed.push({ url: (this as any).url, opts: (this as any).opts, transport });
      return Promise.resolve(transport as any);
    });

    readFileSpy.mockResolvedValueOnce(Buffer.from('TEST-CA'));
    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: 'https://proxy.example.com',
      jwt: 'jwt-2',
      ttlSeconds: 0,
    });

    const first = await AegisResolver.resolve('aegis+w-ca', { resolveAttempt: 1 } as any);
    await (first as any).opener();

    expect(readFileSpy).toHaveBeenCalledWith('/tmp/ca.pem');
    expect(constructed[0].opts.tls.ca).toBeInstanceOf(Buffer);

    (out.appendLine as jest.Mock).mockClear();
    readFileSpy.mockRejectedValueOnce(new Error('missing'));
    const second = await AegisResolver.resolve('aegis+w-ca', { resolveAttempt: 2 } as any);
    await (second as any).opener();
    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('failed to read CA bundle'));
  });

  test('schedules renewal and triggers forceReconnect', async () => {
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    jest.spyOn(config, 'getSettings').mockReturnValue({
      heartbeatIntervalMs: 200,
      idleTimeoutMs: 600,
      logLevel: 'debug',
      security: { rejectUnauthorized: false, caPath: '' },
      defaultWorkspaceId: 'fallback',
    });

    let transportEnd: jest.Mock | undefined;
    jest.spyOn(ConnectionManager.prototype, 'open').mockImplementation(function (this: any) {
      const closeEmitter = createEmitter<Error | undefined>();
      const endEmitter = createEmitter<void>();
      const transportEndMock = jest.fn(() => {
        endEmitter.fire();
      });
      transportEnd = transportEndMock;
      const transport = {
        onDidReceiveMessage: createEmitter<Uint8Array>().event,
        onDidClose: closeEmitter.event,
        onDidEnd: endEmitter.event,
        send: jest.fn(),
        end: transportEndMock,
      };
      return Promise.resolve(transport as any);
    });

    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: 'https://proxy.example.com',
      jwt: 'jwt-renew',
      ttlSeconds: 60,
    } as any);

    const result = await AegisResolver.resolve('aegis+w-renew', { resolveAttempt: 1 } as any);
    await (result as any).opener();

    const renewalCall = [...timeoutSpy.mock.calls].reverse().find(([, delay]) => typeof delay === 'number' && delay >= 5000);
    expect(renewalCall).toBeDefined();

    const [callback] = renewalCall as [() => void, number];
    const invokeCountBefore = transportEnd?.mock.calls.length ?? 0;
    callback();

    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('renewing ticket'));
    expect(transportEnd).toBeDefined();
    expect(transportEnd?.mock.calls.length).toBe(invokeCountBefore + 1);
  });
});
