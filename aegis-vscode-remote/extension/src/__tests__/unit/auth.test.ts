import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import type { ExtensionContext } from 'vscode';

function createTestContext(): ExtensionContext {
  const store = new Map<string, string>();
  return {
    subscriptions: [],
    secrets: {
      async get(key: string) {
        return store.get(key);
      },
      async store(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
  } as unknown as ExtensionContext;
}

function createJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

describe('auth module (OAuth)', () => {
  const SECRET_KEY = 'aegis.auth.session.v1';
let ctx: ExtensionContext;
let auth: typeof import('../../auth');
let vscode: typeof import('vscode');
let fetchMock: jest.MockedFunction<typeof globalThis.fetch>;
let readFileSpy: jest.SpiedFunction<typeof fs.readFile>;

  async function loadModules() {
    jest.resetModules();
    auth = await import('../../auth');
    vscode = await import('vscode');
  }

  beforeEach(async () => {
    ctx = createTestContext();
    fetchMock = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
    (globalThis as any).fetch = fetchMock;
    await loadModules();
    readFileSpy = jest.spyOn(fs, 'readFile');
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileSpy.mockRejectedValue(enoent);
  });

  afterEach(() => {
    jest.clearAllMocks();
    readFileSpy.mockRestore();
  });

  test('initializeAuth registers provider exactly once', async () => {
    await auth.initializeAuth(ctx);
    await auth.initializeAuth(ctx);

    expect(vscode.authentication.registerAuthenticationProvider).toHaveBeenCalledTimes(1);
    expect(ctx.subscriptions).toHaveLength(2);
  });

  test('createSession executes PKCE flow and persists tokens', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const openExternalMock = vscode.env.openExternal as jest.MockedFunction<typeof vscode.env.openExternal>;
    let capturedAuthUrl: string | undefined;
    openExternalMock.mockImplementation(async (uri: any) => {
      capturedAuthUrl = uri.toString();
      return true;
    });

    const tokenPayload = {
      sub: 'user-subject',
      email: 'dev@example.com',
      preferred_username: 'dev-user',
    };

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: createJwt(tokenPayload),
          refresh_token: 'refresh-token',
        expires_in: '3600',
          id_token: createJwt(tokenPayload),
          scope: 'openid profile email offline_access aegis-platform',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const sessionPromise = provider.createSession(['platform'], {});
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(capturedAuthUrl).toBeDefined();

    const state = new URL(capturedAuthUrl!).searchParams.get('state');
    expect(state).toBeTruthy();

    const redirectUri = vscode.Uri.parse(
      `vscode://aegis.aegis-remote/auth?code=test-code&state=${state}`
    );
    await auth.handleAuthUri(redirectUri);
    const session = await sessionPromise;

    expect(session.accessToken).toContain('.');
    expect(session.account.label).toBe('dev@example.com');
    const stored = await ctx.secrets.get(SECRET_KEY);
    expect(stored).toContain('refresh-token');
    expect(session.scopes).toContain('platform');
  });

  test('getSessions refreshes tokens when near expiration', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const expiringToken = createJwt({ sub: 'sub', email: 'soon@example.com' });
    await ctx.secrets.store(
      SECRET_KEY,
      JSON.stringify({
        version: 1,
        accessToken: expiringToken,
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1000,
        scope: 'openid profile',
        account: { id: 'sub', label: 'soon@example.com' },
        userHeader: 'soon@example.com',
      })
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: createJwt({ sub: 'sub', email: 'refreshed@example.com' }),
          refresh_token: 'refresh-2',
          expires_in: 7200,
          scope: 'openid profile',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const sessions = await provider.getSessions(['platform'], {});
    expect(sessions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessions[0].account.label).toBe('refreshed@example.com');
  });

  test('signOut clears persisted session', async () => {
    await ctx.secrets.store(
      SECRET_KEY,
      JSON.stringify({
        version: 1,
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: 'openid',
        account: { id: 'sub', label: 'user@example.com' },
        userHeader: 'user@example.com',
      })
    );

    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;
    await provider.getSessions([], {});

    await auth.signOut();
    expect(await ctx.secrets.get(SECRET_KEY)).toBeUndefined();
  });

  test('requireSession delegates to VS Code authentication API', async () => {
    const mockSession = {
      id: 'delegated',
      accessToken: 'mock-token',
      account: { id: 'user', label: 'user@example.com' },
      scopes: ['platform'],
    } as unknown as import('vscode').AuthenticationSession;

    const getSessionMock = vscode.authentication.getSession as jest.MockedFunction<typeof vscode.authentication.getSession>;
    getSessionMock.mockImplementation(async () => mockSession);

    const session = await auth.requireSession(true);

    expect(vscode.authentication.getSession).toHaveBeenCalledWith('aegis', ['platform'], {
      createIfNone: false,
      silent: true,
    });
    expect(session).toBe(mockSession);
  });

  test('requireSession retries silently when dialogs are suppressed in tests', async () => {
    const mockSession = {
      id: 'delegated',
      accessToken: 'mock-token',
      account: { id: 'user', label: 'user@example.com' },
      scopes: ['platform'],
    } as unknown as import('vscode').AuthenticationSession;

    const getSessionMock = vscode.authentication.getSession as jest.MockedFunction<typeof vscode.authentication.getSession>;
    getSessionMock.mockImplementationOnce(async () => {
      throw new Error('DialogService: refused to show dialog in tests.');
    });
    getSessionMock.mockResolvedValueOnce(mockSession);

    const session = await auth.requireSession(true);

    expect(getSessionMock).toHaveBeenNthCalledWith(1, 'aegis', ['platform'], {
      createIfNone: false,
      silent: true,
    });
    expect(getSessionMock).toHaveBeenNthCalledWith(2, 'aegis', ['platform'], { createIfNone: true });
    expect(session).toBe(mockSession);
  });

  test('requireSession prioritizes automation credentials when AEGIS_TEST_USERNAME is set', async () => {
    const originalFetch = globalThis.fetch;
    const username = 'automation@example.com';
    const password = 'secret';
    process.env.AEGIS_TEST_USERNAME = username;
    process.env.AEGIS_TEST_PASSWORD = password;

    const accessToken = createJwt({ sub: 'user-subject', email: username });
    const idToken = createJwt({ sub: 'user-subject', email: username });

    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ access_token: accessToken, id_token: idToken }),
    }));
    // @ts-expect-error override global fetch for test
    globalThis.fetch = mockFetch;

    const getSessionMock = vscode.authentication.getSession as jest.MockedFunction<typeof vscode.authentication.getSession>;

    try {
      const session = await auth.requireSession(true);

      // When AEGIS_TEST_USERNAME is set, automation credentials are used directly
      // without calling vscode.authentication.getSession at all.
      expect(getSessionMock).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(session?.accessToken).toBe(accessToken);
      expect(session?.account.label).toBe(username);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.AEGIS_TEST_USERNAME;
      delete process.env.AEGIS_TEST_PASSWORD;
    }
  });

  test('requireSession uses workspace session token when available', async () => {
    const workspaceToken = createJwt({ sub: 'workspace-subject', email: 'workspace@example.com' });
    readFileSpy.mockResolvedValueOnce(JSON.stringify({ user_token: workspaceToken, user_email: 'workspace@example.com' }));

    const getSessionMock = vscode.authentication.getSession as jest.MockedFunction<typeof vscode.authentication.getSession>;
    getSessionMock.mockImplementationOnce(async () => {
      throw new Error('DialogService: refused to show dialog in tests.');
    });
    getSessionMock.mockResolvedValueOnce(undefined);

    const session = await auth.requireSession(true);

    expect(getSessionMock).toHaveBeenNthCalledWith(1, 'aegis', ['platform'], {
      createIfNone: false,
      silent: true,
    });
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(readFileSpy).toHaveBeenCalled();
    expect(session?.accessToken).toBe(workspaceToken);
    expect(session?.account.label).toBe('workspace@example.com');
    expect(session?.account.id).toBe('workspace-subject');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('handleAuthUri ignores non-auth paths and returns false', async () => {
    await auth.initializeAuth(ctx);
    const ignored = await auth.handleAuthUri(vscode.Uri.parse('vscode://aegis.aegis-remote/aegis+wid'));
    expect(ignored).toBe(false);
  });

  test('handleAuthUri resolves pending session errors for state mismatch', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const openExternalMock = vscode.env.openExternal as jest.MockedFunction<typeof vscode.env.openExternal>;
    let capturedAuthUrl: string | undefined;
    openExternalMock.mockImplementation(async (uri: any) => {
      capturedAuthUrl = uri.toString();
      return true;
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: createJwt({ sub: 'sub' }), expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const sessionPromise = provider.createSession(['platform'], {});
    expect(capturedAuthUrl).toBeDefined();
    const state = new URL(capturedAuthUrl!).searchParams.get('state');
    expect(state).toBeTruthy();

    await auth.handleAuthUri(vscode.Uri.parse('vscode://aegis.aegis-remote/auth?code=abc&state=other'));
    await expect(sessionPromise).rejects.toThrow(/state mismatch/i);
  });

  test('handleAuthUri propagates authorization errors', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const openExternalMock = vscode.env.openExternal as jest.MockedFunction<typeof vscode.env.openExternal>;
    let capturedAuthUrl: string | undefined;
    openExternalMock.mockImplementation(async (uri: any) => {
      capturedAuthUrl = uri.toString();
      return true;
    });

    const sessionPromise = provider.createSession(['platform'], {});
    const state = new URL(capturedAuthUrl!).searchParams.get('state');
    expect(state).toBeTruthy();

    await auth.handleAuthUri(
      vscode.Uri.parse(`vscode://aegis.aegis-remote/auth?error=access_denied&error_description=failure&state=${state}`)
    );
    await expect(sessionPromise).rejects.toThrow(/access_denied/i);
  });

  test('getSessionUser derives preferred username when metadata missing', async () => {
    const { getSessionUser } = auth;
    const token = createJwt({ sub: 'user-id', preferred_username: 'dev-user' });
    const user = getSessionUser({
      id: 'aegis-default',
      accessToken: token,
      account: { id: 'ignored', label: 'ignored' },
      scopes: [],
    } as any);
    expect(user).toBe('dev-user');
  });

  test('getSessions clears expired session without refresh token', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    await ctx.secrets.store(
      SECRET_KEY,
      JSON.stringify({
        version: 1,
        accessToken: createJwt({ sub: 'sub', email: 'expired@example.com' }),
        expiresAt: Date.now() - 10_000,
        scope: 'openid',
        account: { id: 'sub', label: 'expired@example.com' },
      })
    );

    const sessions = await provider.getSessions(['platform'], {});
    expect(sessions).toHaveLength(0);
    expect(await ctx.secrets.get(SECRET_KEY)).toBeUndefined();
  });

  test('getSessions clears persisted session when refresh fails', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    await ctx.secrets.store(
      SECRET_KEY,
      JSON.stringify({
        version: 1,
        accessToken: createJwt({ sub: 'sub', email: 'refresh@example.com' }),
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
        scope: 'openid',
        account: { id: 'sub', label: 'refresh@example.com' },
        userHeader: 'refresh@example.com',
      })
    );

    fetchMock.mockImplementation(async () => new Response('bad', { status: 400 }));

    await expect(provider.getSessions(['platform'], {})).rejects.toThrow(/token refresh failed/i);
    expect(await ctx.secrets.get(SECRET_KEY)).toBeUndefined();
  });

  test('handleAuthUri returns false when provider not initialized', async () => {
    const result = await auth.handleAuthUri(
      vscode.Uri.parse('vscode://aegis.aegis-remote/auth?code=abc&state=123')
    );
    expect(result).toBe(false);
  });

  test('getSessionUser falls back to account label for malformed token', () => {
    const { getSessionUser } = auth;
    const result = getSessionUser({
      id: 'aegis-default',
      accessToken: 'invalid-token',
      account: { id: 'id', label: 'fallback@example.com' },
      scopes: [],
    } as any);
    expect(result).toBe('aegis-user');
  });

  test('createSession surfaces helpful message when token exchange fetch fails', async () => {
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const openExternalMock = vscode.env.openExternal as jest.MockedFunction<typeof vscode.env.openExternal>;
    openExternalMock.mockImplementation(async () => true);

    fetchMock.mockRejectedValueOnce(new TypeError('self signed certificate'));

    const sessionPromise = provider.createSession(['platform'], {});
    const state = new URL((openExternalMock.mock.calls[0][0] as any).toString()).searchParams.get('state');
    await auth.handleAuthUri(
      vscode.Uri.parse(`vscode://aegis.aegis-remote/auth?code=dummy-code&state=${state}`)
    );

    await expect(sessionPromise).rejects.toThrow(/Token exchange failed: .*self signed certificate/i);
  });

  test('corrupt persisted payload is discarded', async () => {
    await ctx.secrets.store(SECRET_KEY, '{not-json');
    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const sessions = await provider.getSessions(['platform'], {});
    expect(sessions).toHaveLength(0);
    expect(await ctx.secrets.get(SECRET_KEY)).toBeUndefined();
  });

  test('legacy secrets are removed when hydrating', async () => {
    const LEGACY_TOKEN_KEY = 'aegis.auth.token';
    const LEGACY_SUBJECT_KEY = 'aegis.auth.subject';

    await ctx.secrets.store(LEGACY_TOKEN_KEY, 'legacy-token');
    await ctx.secrets.store(LEGACY_SUBJECT_KEY, 'legacy-subject');

    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock
      .calls[0][2] as any;

    const sessions = await provider.getSessions(['platform'], {});
    expect(sessions).toHaveLength(0);
    expect(await ctx.secrets.get(LEGACY_TOKEN_KEY)).toBeUndefined();
    expect(await ctx.secrets.get(LEGACY_SUBJECT_KEY)).toBeUndefined();
  });
});
