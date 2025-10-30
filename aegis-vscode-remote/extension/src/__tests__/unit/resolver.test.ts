import { afterEach, describe, expect, jest, test } from '@jest/globals';
jest.mock('ws');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AegisResolver, forceReconnect } from '../../resolver';
import { ConnectionManager } from '../../connection';
import * as platform from '../stubs/platform.stub';
import * as config from '../stubs/config.stub';
import { out } from '../stubs/ui.stub';

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

type TestSettings = ReturnType<typeof config.getSettings>;

const baseSettings: TestSettings = {
  ...config.getSettings(),
};

type SettingsOverrides = {
  security?: Partial<TestSettings['security']>;
  platform?: Partial<TestSettings['platform']>;
  auth?: Partial<TestSettings['auth']>;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  logLevel?: TestSettings['logLevel'];
  defaultWorkspaceId?: string;
};

function buildSettings(overrides: SettingsOverrides) {
  return {
    ...baseSettings,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? baseSettings.heartbeatIntervalMs,
    idleTimeoutMs: overrides.idleTimeoutMs ?? baseSettings.idleTimeoutMs,
    logLevel: overrides.logLevel ?? baseSettings.logLevel,
    defaultWorkspaceId: overrides.defaultWorkspaceId ?? baseSettings.defaultWorkspaceId,
    security: { ...baseSettings.security, ...(overrides.security ?? {}) },
    platform: { ...baseSettings.platform, ...(overrides.platform ?? {}) },
    auth: { ...baseSettings.auth, ...(overrides.auth ?? {}) },
  };
}

describe('AegisResolver', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    (out.appendLine as jest.Mock).mockClear();
  });

  test('builds wss URL with /proxy/<wid> and applies TLS options', async () => {
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: true, caPath: '' } })
    );
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
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: false, caPath: '/tmp/ca.pem' } })
    );

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

  test('handles diverse proxy url formats', async () => {
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: false, caPath: '' }, defaultWorkspaceId: 'wid' })
    );

    jest.spyOn(ConnectionManager.prototype, 'open').mockImplementation(async () => ({
      onDidReceiveMessage: jest.fn(),
      onDidClose: jest.fn(),
      onDidEnd: jest.fn(),
      send: jest.fn(),
      end: jest.fn(),
    } as any));

    const cases = [
      { proxyUrl: 'proxy.example.com', expected: 'wss://proxy.example.com/proxy/wid' },
      { proxyUrl: 'http://host/proxy', expected: 'wss://host/proxy/wid' },
      { proxyUrl: 'https://host/proxy/wid', expected: 'wss://host/proxy/wid' },
      { proxyUrl: 'http://host/custom/proxy/path', expected: 'wss://host/custom/proxy/path' },
    ];

    for (const { proxyUrl, expected } of cases) {
      (out.appendLine as jest.Mock).mockClear();
      jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
        proxyUrl,
        jwt: 'jwt',
        ttlSeconds: 0,
      });

      const result = await AegisResolver.resolve('aegis+wid', { resolveAttempt: 1 } as any);
      await (result as any).opener();

      const log = (out.appendLine as jest.Mock).mock.calls.find(([msg]) => String(msg).includes('got ticket'));
      expect(log?.[0]).toContain(expected);
    }
  });

  test('merges CA sources and sets client cert options', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aegis-ca-'));
    const caPath = path.join(tempDir, 'ca.pem');
    await fs.promises.writeFile(caPath, 'file-ca');

    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: true, caPath }, defaultWorkspaceId: 'wid' })
    );

    const constructed: Array<{ url: string; opts: any }> = [];
    jest.spyOn(ConnectionManager.prototype, 'open').mockImplementation(function (this: any) {
      const transport = {
        onDidReceiveMessage: createEmitter<Uint8Array>().event,
        onDidClose: createEmitter<Error | undefined>().event,
        onDidEnd: createEmitter<void>().event,
        send: jest.fn(),
        end: jest.fn(),
      };
      constructed.push({ url: (this as any).url, opts: (this as any).opts });
      return Promise.resolve(transport as any);
    });

    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: 'https://host.example.com',
      jwt: 'jwt',
      ttlSeconds: 0,
      caPem: 'ticket-ca',
      certPem: 'cert',
      keyPem: 'key',
      serverName: 'server.name',
    } as any);

    try {
      const result = await AegisResolver.resolve('aegis+wid', { resolveAttempt: 1 } as any);
      await (result as any).opener();

      expect(constructed).toHaveLength(1);
      const tls = constructed[0].opts.tls;
      expect(Array.isArray(tls.ca)).toBe(true);
      expect((tls.ca as Buffer[]).map((buf: Buffer) => buf.toString())).toEqual(['ticket-ca', 'file-ca']);
      expect(Buffer.isBuffer(tls.cert) && tls.cert.toString()).toBe('cert');
      expect(Buffer.isBuffer(tls.key) && tls.key.toString()).toBe('key');
      expect(tls.servername).toBe('server.name');
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('surface error for missing or invalid proxy url', async () => {
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: false, caPath: '' }, defaultWorkspaceId: 'wid' })
    );

    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: '',
      jwt: 'jwt',
      ttlSeconds: 0,
    });

    const missing = await AegisResolver.resolve('aegis+wid', { resolveAttempt: 1 } as any);
    await expect((missing as any).opener()).rejects.toThrow('Proxy URL missing');

    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: '://bad',
      jwt: 'jwt',
      ttlSeconds: 0,
    });

    const invalid = await AegisResolver.resolve('aegis+wid', { resolveAttempt: 1 } as any);
    await expect((invalid as any).opener()).rejects.toThrow('Invalid proxy URL');
  });

  test('schedules renewal and triggers forceReconnect', async () => {
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: false, caPath: '' }, defaultWorkspaceId: 'fallback' })
    );

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

  test('forceReconnect ends active transport once', async () => {
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({ security: { rejectUnauthorized: false, caPath: '' }, defaultWorkspaceId: 'wid' })
    );

    const transport = {
      onDidReceiveMessage: createEmitter<Uint8Array>().event,
      onDidClose: createEmitter<Error | undefined>().event,
      onDidEnd: createEmitter<void>().event,
      send: jest.fn(),
      end: jest.fn(),
    };

    jest.spyOn(ConnectionManager.prototype, 'open').mockResolvedValue(transport as any);
    jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: 'https://host.example.com',
      jwt: 'jwt',
      ttlSeconds: 0,
    } as any);

    const result = await AegisResolver.resolve('aegis+wid', { resolveAttempt: 1 } as any);
    await (result as any).opener();

    forceReconnect();
    expect(transport.end).toHaveBeenCalledTimes(1);

    // Second call should no-op because lastEnd cleared.
    forceReconnect();
    expect(transport.end).toHaveBeenCalledTimes(1);
  });

  test('resolve falls back to default workspace id when authority omits wid', async () => {
    jest.spyOn(config, 'getSettings').mockReturnValue(
      buildSettings({
        heartbeatIntervalMs: 100,
        idleTimeoutMs: 400,
        logLevel: 'info',
        security: { rejectUnauthorized: false, caPath: '' },
        defaultWorkspaceId: 'fallback-wid',
      })
    );

    const ticketSpy = jest.spyOn(platform, 'issueProxyTicket').mockResolvedValue({
      proxyUrl: 'https://proxy.example.com',
      jwt: 'jwt',
      ttlSeconds: 0,
    } as any);

    jest.spyOn(ConnectionManager.prototype, 'open').mockResolvedValue({
      onDidReceiveMessage: jest.fn(),
      onDidClose: jest.fn(),
      onDidEnd: jest.fn(),
      send: jest.fn(),
      end: jest.fn(),
    } as any);

    const result = await AegisResolver.resolve('aegis', { resolveAttempt: 1 } as any);
    await (result as any).opener();

    expect(ticketSpy).toHaveBeenCalledWith('fallback-wid');
  });
});
