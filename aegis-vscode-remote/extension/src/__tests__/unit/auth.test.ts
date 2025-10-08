import { describe, expect, jest, test } from '@jest/globals';
import type { ExtensionContext } from 'vscode';

describe('auth module', () => {
  const SECRET_TOKEN_KEY = 'aegis.auth.token';
  const SECRET_SUBJECT_KEY = 'aegis.auth.subject';

  async function loadModules() {
    jest.resetModules();
    const auth = await import('../../auth');
    const vscode = await import('vscode');
    jest.clearAllMocks();
    return { auth, vscode };
  }

  function createContext(): ExtensionContext {
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

  test('initializeAuth registers provider exactly once', async () => {
    const { auth, vscode } = await loadModules();
    const ctx = createContext();

    await auth.initializeAuth(ctx);
    await auth.initializeAuth(ctx);

    expect(vscode.authentication.registerAuthenticationProvider).toHaveBeenCalledTimes(1);
    expect(ctx.subscriptions).toHaveLength(2);
  });

  test('requireSession creates session, stores secrets, and emits change', async () => {
    const { auth, vscode } = await loadModules();
    const ctx = createContext();

    const showInputBoxMock = vscode.window.showInputBox as jest.MockedFunction<typeof vscode.window.showInputBox>;
    showInputBoxMock.mockResolvedValueOnce('dev@example.com');
    showInputBoxMock.mockResolvedValueOnce('token-123');

    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock.calls[0][2] as any;

    const sessionEvents: any[] = [];
    provider.onDidChangeSessions((evt: any) => sessionEvents.push(evt));

    const getSessionMock = vscode.authentication.getSession as jest.MockedFunction<typeof vscode.authentication.getSession>;
    getSessionMock.mockImplementation(async (_id: string, scopes: readonly string[], options: any) => {
      const existing = await provider.getSessions(scopes, options);
      if (existing.length > 0) {
        return existing[0];
      }
      if (options?.createIfNone) {
        return provider.createSession(scopes, options);
      }
      return undefined;
    });

    const session = await auth.requireSession(true);
    expect(session).toBeDefined();
    expect(session?.accessToken).toBe('token-123');
    expect(session?.scopes).toContain('platform');

    expect(await ctx.secrets.get(SECRET_TOKEN_KEY)).toBe('token-123');
    expect(await ctx.secrets.get(SECRET_SUBJECT_KEY)).toBe('dev@example.com');
    expect(sessionEvents[0]?.added?.[0]?.accessToken).toBe('token-123');
  });

  test('signOut clears stored secrets and emits removal event', async () => {
    const { auth, vscode } = await loadModules();
    const ctx = createContext();

    const showInputBoxMock = vscode.window.showInputBox as jest.MockedFunction<typeof vscode.window.showInputBox>;
    showInputBoxMock.mockResolvedValueOnce('dev@example.com');
    showInputBoxMock.mockResolvedValueOnce('token-123');

    await auth.initializeAuth(ctx);
    const provider = (vscode.authentication.registerAuthenticationProvider as jest.Mock).mock.calls[0][2] as any;

    const sessionEvents: any[] = [];
    provider.onDidChangeSessions((evt: any) => sessionEvents.push(evt));

    await provider.createSession(['platform'], {});
    await auth.signOut();

    expect(await ctx.secrets.get(SECRET_TOKEN_KEY)).toBeUndefined();
    expect(await ctx.secrets.get(SECRET_SUBJECT_KEY)).toBeUndefined();
    const removal = sessionEvents.find((evt: any) => Array.isArray(evt.removed) && evt.removed.length === 1);
    expect(removal).toBeTruthy();
  });
});
