import * as crypto from 'crypto';
import { URLSearchParams } from 'url';
import * as vscode from 'vscode';
import { getSettings } from './config';
import { getHttpDispatcher } from './http';

const AUTH_PROVIDER_ID = 'aegis';
const AUTH_PROVIDER_LABEL = 'Aegis Platform';
const SECRET_SESSION_KEY = 'aegis.auth.session.v1';
const LEGACY_SECRET_TOKEN_KEY = 'aegis.auth.token';
const LEGACY_SECRET_SUBJECT_KEY = 'aegis.auth.subject';
const SESSION_ID = 'aegis-default';
const LOGIN_TIMEOUT_MS = 120_000;
const REFRESH_SKEW_MS = 60_000;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  id_token?: string;
  scope?: string;
  token_type?: string;
  [key: string]: unknown;
};

interface PersistedSession {
  version: 1;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  scope: string;
  account: { id: string; label: string };
  userHeader?: string;
}

interface PendingAuth {
  state: string;
  codeVerifier: string;
  scope: string;
  resolve: (session: PersistedSession) => void;
  reject: (err: unknown) => void;
  timeout: NodeJS.Timeout;
}

const sessionMetadata = new Map<string, { userHeader?: string }>();

function toBase64Url(buffer: Buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(crypto.randomBytes(32));
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function parseJwt(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  const payload = parts[1];
  const padded = payload.padEnd(payload.length + (4 - (payload.length % 4)) % 4, '=');
  try {
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function deriveAccountInfo(claims: Record<string, unknown> | undefined, fallbackSubject?: string) {
  const subject =
    (typeof claims?.sub === 'string' && claims.sub) ||
    fallbackSubject ||
    'aegis-user';
  const label =
    (typeof claims?.email === 'string' && claims.email) ||
    (typeof claims?.preferred_username === 'string' && claims.preferred_username) ||
    (typeof claims?.name === 'string' && claims.name) ||
    subject;
  const userHeader =
    (typeof claims?.email === 'string' && claims.email) ||
    (typeof claims?.preferred_username === 'string' && claims.preferred_username) ||
    subject;
  return { account: { id: subject, label }, userHeader };
}

function computeExpiresAt(expiresIn: number | string | undefined): number {
  let seconds: number | undefined;
  if (typeof expiresIn === 'number') {
    seconds = expiresIn;
  } else if (typeof expiresIn === 'string') {
    const parsed = Number.parseInt(expiresIn, 10);
    if (!Number.isNaN(parsed)) {
      seconds = parsed;
    }
  }
  if (!seconds || seconds <= 0) {
    seconds = 5 * 60;
  }
  return Date.now() + seconds * 1000;
}

function recordMetadata(session: PersistedSession) {
  sessionMetadata.set(SESSION_ID, { userHeader: session.userHeader ?? session.account.label });
}

function buildScope(requested: readonly string[], configured: readonly string[], audience?: string) {
  const scopeSet = new Set<string>();
  for (const value of configured) {
    const trimmed = value.trim();
    if (trimmed) {
      scopeSet.add(trimmed);
    }
  }
  for (const value of requested) {
    const trimmed = value.trim();
    if (trimmed) {
      scopeSet.add(trimmed);
    }
  }
  if (audience) {
    scopeSet.add(audience.trim());
  }
  return Array.from(scopeSet).join(' ');
}

let providerInstance: AegisAuthenticationProvider | undefined;

class AegisAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private sessions: vscode.AuthenticationSession[] = [];
  private persisted: PersistedSession | undefined;
  private pending?: PendingAuth;
  private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose() {
    this._onDidChangeSessions.dispose();
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new vscode.CancellationError());
      this.pending = undefined;
    }
  }

  private async ensurePersistedSession(): Promise<PersistedSession | undefined> {
    if (this.persisted) {
      return this.persisted;
    }

    const raw = await this.context.secrets.get(SECRET_SESSION_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedSession;
        if (parsed && typeof parsed.accessToken === 'string') {
          this.persisted = parsed;
          recordMetadata(parsed);
          return parsed;
        }
      } catch {
        await this.context.secrets.delete(SECRET_SESSION_KEY);
      }
    }

    // Legacy secret cleanup (manual token flow)
    const legacyToken = await this.context.secrets.get(LEGACY_SECRET_TOKEN_KEY);
    if (legacyToken) {
      await this.context.secrets.delete(LEGACY_SECRET_TOKEN_KEY);
    }
    const legacySubject = await this.context.secrets.get(LEGACY_SECRET_SUBJECT_KEY);
    if (legacySubject) {
      await this.context.secrets.delete(LEGACY_SECRET_SUBJECT_KEY);
    }

    return undefined;
  }

  private async storePersisted(session: PersistedSession) {
    this.persisted = session;
    recordMetadata(session);
    await this.context.secrets.store(SECRET_SESSION_KEY, JSON.stringify(session));
    await this.context.secrets.delete(LEGACY_SECRET_TOKEN_KEY);
    await this.context.secrets.delete(LEGACY_SECRET_SUBJECT_KEY);
  }

  private async clearPersisted() {
    this.sessions = [];
    this.persisted = undefined;
    sessionMetadata.delete(SESSION_ID);
    await this.context.secrets.delete(SECRET_SESSION_KEY);
    await this.context.secrets.delete(LEGACY_SECRET_TOKEN_KEY);
    await this.context.secrets.delete(LEGACY_SECRET_SUBJECT_KEY);
  }

  private isExpiringSoon(session: PersistedSession) {
    return session.expiresAt <= Date.now() + REFRESH_SKEW_MS;
  }

  private buildSession(scopes: readonly string[]): vscode.AuthenticationSession {
    const hydrated = this.persisted;
    if (!hydrated) {
      throw new Error('Authentication session not available.');
    }
    const sessionScopes = scopes.length > 0 ? [...new Set(scopes)] : ['platform'];
    const session: vscode.AuthenticationSession = {
      id: SESSION_ID,
      accessToken: hydrated.accessToken,
      account: hydrated.account,
      scopes: sessionScopes,
    };
    recordMetadata(hydrated);
    return session;
  }

  async getSessions(scopes?: readonly string[], _options?: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
    const requested = scopes ?? ['platform'];
    const persisted = await this.ensurePersistedSession();
    if (!persisted) {
      this.sessions = [];
      return [];
    }

    if (this.isExpiringSoon(persisted) && persisted.refreshToken) {
      try {
        const refreshed = await this.refreshTokens(persisted.refreshToken, persisted.scope);
        const merged: PersistedSession = {
          ...persisted,
          ...refreshed,
          expiresAt: refreshed.expiresAt,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? persisted.refreshToken,
          userHeader: refreshed.userHeader ?? persisted.userHeader,
          scope: refreshed.scope ?? persisted.scope,
          account: refreshed.account ?? persisted.account,
        };
        await this.storePersisted(merged);
      } catch (err) {
        await this.clearPersisted();
        this._onDidChangeSessions.fire({ added: [], removed: this.sessions, changed: [] });
        throw err instanceof Error ? err : new Error(String(err));
      }
    } else if (this.isExpiringSoon(persisted) && !persisted.refreshToken) {
      await this.clearPersisted();
      this._onDidChangeSessions.fire({ added: [], removed: this.sessions, changed: [] });
      return [];
    }

    const session = this.buildSession(requested);
    this.sessions = [session];
    return [...this.sessions];
  }

  async createSession(scopes: readonly string[], _options?: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
    const settings = getSettings();
    const { auth, platform } = settings;
    if (!auth.authority || !auth.clientId) {
      throw new Error('Configure "aegisRemote.auth.authority" and "aegisRemote.auth.clientId" before signing in.');
    }

    const scope = buildScope(scopes, auth.scopes, platform?.authScope);
    const { verifier, challenge } = createPkcePair();
    const state = toBase64Url(crypto.randomBytes(18));
    const authUrl = new URL(`${auth.authority.replace(/\/+$/u, '')}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', auth.clientId);
    authUrl.searchParams.set('redirect_uri', auth.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    if (auth.prompt) {
      authUrl.searchParams.set('prompt', auth.prompt);
    }

    const pendingPromise = new Promise<PersistedSession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        reject(new vscode.CancellationError());
      }, LOGIN_TIMEOUT_MS);
      this.pending = { state, codeVerifier: verifier, scope, resolve, reject, timeout };
    });

    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

    let persisted: PersistedSession;
    try {
      persisted = await pendingPromise;
    } finally {
      if (this.pending) {
        clearTimeout(this.pending.timeout);
        this.pending = undefined;
      }
    }

    await this.storePersisted(persisted);
    const session = this.buildSession(scopes);
    this.sessions = [session];
    this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
    return session;
  }

  async removeSession(_id: string): Promise<void> {
    const removed = [...this.sessions];
    await this.clearPersisted();
    this._onDidChangeSessions.fire({ added: [], removed, changed: [] });
  }

  async clearSession() {
    await this.removeSession(SESSION_ID);
  }

  async handleUri(uri: vscode.Uri): Promise<boolean> {
    if (uri.path !== '/auth') {
      return false;
    }
    const pending = this.pending;
    if (!pending) {
      return true;
    }

    const params = new URLSearchParams(uri.query ?? '');
    const returnedState = params.get('state') ?? '';
    if (returnedState !== pending.state) {
      pending.reject(new Error('OAuth state mismatch.'));
      return true;
    }

    const error = params.get('error');
    if (error) {
      const description = params.get('error_description');
      pending.reject(new Error(description ? `${error}: ${description}` : error));
      return true;
    }

    const code = params.get('code');
    if (!code) {
      pending.reject(new Error('Authorization response missing code.'));
      return true;
    }

    try {
      const session = await this.exchangeAuthorizationCode(code, pending.codeVerifier, pending.scope);
      pending.resolve(session);
    } catch (err) {
      pending.reject(err);
    }
    return true;
  }

  private async exchangeAuthorizationCode(code: string, verifier: string, scope: string): Promise<PersistedSession> {
    const { auth } = getSettings();
    const tokenResponse = await this.postTokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: auth.redirectUri,
        client_id: auth.clientId,
        code_verifier: verifier,
      }),
      'Token exchange'
    );
    return this.buildPersistedFromResponse(tokenResponse, scope);
  }

  private async refreshTokens(refreshToken: string, scope: string): Promise<PersistedSession> {
    const { auth } = getSettings();
    const tokenResponse = await this.postTokenRequest(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: auth.clientId,
        scope,
      }),
      'Token refresh'
    );
    return this.buildPersistedFromResponse(tokenResponse, scope);
  }

  private async postTokenRequest(
    body: URLSearchParams,
    context: 'Token exchange' | 'Token refresh'
  ): Promise<TokenResponse> {
    const { auth } = getSettings();
    const tokenUrl = `${auth.authority.replace(/\/+$/u, '')}/protocol/openid-connect/token`;

    let response: Response;
    try {
      const dispatcher = getHttpDispatcher();
      response = await globalThis.fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      let reason = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      if (cause instanceof Error && cause.message) {
        reason += ` (${cause.message})`;
      }
      throw new Error(
        `${context} failed: ${reason}. Verify the Keycloak URL, client configuration, and TLS trust (aegisRemote.security.caPath).`,
        { cause: err }
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${context} failed (${response.status}): ${text || 'No response body'}`);
    }

    return (await response.json()) as TokenResponse;
  }

  private buildPersistedFromResponse(tokenResponse: TokenResponse, scope: string): PersistedSession {
    if (!tokenResponse.access_token) {
      throw new Error('Token response did not include an access token.');
    }
    const claims = parseJwt(tokenResponse.id_token ?? tokenResponse.access_token);
    const { account, userHeader } = deriveAccountInfo(claims);
    const expiresAt = computeExpiresAt(tokenResponse.expires_in);
    return {
      version: 1,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      idToken: tokenResponse.id_token,
      expiresAt,
      scope: tokenResponse.scope ?? scope,
      account,
      userHeader,
    };
  }
}

export async function initializeAuth(context: vscode.ExtensionContext) {
  if (providerInstance) {
    return;
  }
  providerInstance = new AegisAuthenticationProvider(context);
  context.subscriptions.push(providerInstance);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID,
      AUTH_PROVIDER_LABEL,
      providerInstance,
      { supportsMultipleAccounts: false }
    )
  );
}

export async function requireSession(createIfNone = true): Promise<vscode.AuthenticationSession | undefined> {
  const token = process.env.AEGIS_TEST_TOKEN;
  if (token) {
    const subject = (process.env.AEGIS_TEST_EMAIL ?? 'aegis-test-user').trim();
    return {
      id: 'aegis-test-session',
      accessToken: token,
      account: { id: subject, label: subject },
      scopes: ['platform'],
    };
  }
  return vscode.authentication.getSession(AUTH_PROVIDER_ID, ['platform'], { createIfNone });
}

export async function signOut() {
  if (providerInstance) {
    await providerInstance.clearSession();
  }
}

export async function handleAuthUri(uri: vscode.Uri): Promise<boolean> {
  if (!providerInstance) {
    return false;
  }
  return providerInstance.handleUri(uri);
}

export function getSessionUser(session: vscode.AuthenticationSession): string | undefined {
  const meta = sessionMetadata.get(session.id);
  if (meta?.userHeader) {
    return meta.userHeader;
  }
  const claims = parseJwt(session.accessToken);
  const { userHeader } = deriveAccountInfo(claims);
  return userHeader;
}
