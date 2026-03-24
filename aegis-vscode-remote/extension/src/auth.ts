import * as crypto from 'crypto';
import { URLSearchParams } from 'url';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { getSettings } from './config';
import { getHttpDispatcher } from './http';
import { withRetry } from './errors';
import { out } from './ui';
import { isSecureMode } from './secure-mode';

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
let automationSessionCache: vscode.AuthenticationSession | undefined;

async function automationSessionFromEnv(): Promise<vscode.AuthenticationSession | undefined> {
  if (isSecureMode()) {
    out.appendLine('[auth] automationSessionFromEnv disabled in secure mode');
    return undefined;
  }

  if (automationSessionCache) {
    out.appendLine(`[auth] returning cached automation session for ${automationSessionCache.account.label}`);
    return automationSessionCache;
  }

  const username = process.env.AEGIS_TEST_USERNAME?.trim();
  const password = process.env.AEGIS_TEST_PASSWORD ?? '';
  out.appendLine(`[auth] automationSessionFromEnv: username=${username ? username : '(not set)'}, password=${password ? '***' : '(not set)'}`);
  const sessionFromFile = await loadSessionFromWorkspaceFile();
  if (sessionFromFile) {
    const { token, email } = sessionFromFile;
    const claims = parseJwt(token);
    const exp = typeof claims?.exp === 'number' ? claims.exp : 0;
    if (exp > 0 && exp * 1000 < Date.now()) {
      out.appendLine(`[auth] workspace file token expired (exp=${new Date(exp * 1000).toISOString()}), skipping`);
    } else {
      out.appendLine(`[auth] found session from workspace file (token ${token.length} chars)`);
      const { account, userHeader } = deriveAccountInfo(claims, email);
      const session: vscode.AuthenticationSession = {
        id: SESSION_ID,
        accessToken: token,
        account,
        scopes: ['platform'],
      };
      sessionMetadata.set(SESSION_ID, { userHeader });
      automationSessionCache = session;
      return session;
    }
  }

  if (!username || !password) {
    return undefined;
  }

  const settings = getSettings();
  const authority = (process.env.AEGIS_AUTH_AUTHORITY ?? (settings.auth.authority || '')).trim().replace(/\/+$/u, '');
  if (!authority) {
    throw new Error(
      'No auth authority configured. Set "aegisRemote.auth.authority" in VS Code settings or AEGIS_AUTH_AUTHORITY environment variable.'
    );
  }
  const clientId = process.env.AEGIS_AUTH_CLIENT_ID?.trim() || settings.auth.clientId || 'vscode-extension';
  const audience = process.env.AEGIS_PLATFORM_AUTH_SCOPE?.trim() || process.env.AEGIS_AUTH_SCOPE?.trim() || settings.platform.authScope || undefined;

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('client_id', clientId);
  body.set('username', username);
  body.set('password', password);
  if (audience) {
    body.set('audience', audience);
  }
  const disableOffline = [
    process.env.AEGIS_AUTH_DISABLE_OFFLINE,
    process.env.AEGIS_DISABLE_OFFLINE_SCOPE,
  ]
    .map((value) => (value ?? '').trim().toLowerCase())
    .some((value) => value === '1' || value === 'true' || value === 'yes');
  const scopeParts = ['openid', 'profile', 'email'];
  if (!disableOffline) {
    scopeParts.push('offline_access');
  }
  const scope = scopeParts.join(' ');
  body.set('scope', scope);

  const tokenUrl = `${authority}/protocol/openid-connect/token`;
  out.appendLine(`[auth] automated login: fetching token from ${tokenUrl} as ${username}`);
  const dispatcher = getHttpDispatcher();
  let response: Response;
  try {
    response = await globalThis.fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (fetchErr) {
    out.appendLine(`[auth] automated login fetch error: ${fetchErr}`);
    throw fetchErr;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    out.appendLine(`[auth] automated login failed: ${response.status} ${response.statusText} body=${errorBody}`);
    throw new Error(`Automated Keycloak login failed (${response.status} ${response.statusText}).`);
  }

  const tokenResponse = (await response.json()) as TokenResponse;
  const accessToken = tokenResponse.access_token?.trim();
  if (!accessToken) {
    out.appendLine('[auth] automated login: no access_token in response');
    throw new Error('Automated Keycloak login did not return an access token.');
  }
  out.appendLine(`[auth] automated login: got access_token (${accessToken.length} chars)`);
  const claims = parseJwt(tokenResponse.id_token ?? accessToken);
  const { account, userHeader } = deriveAccountInfo(claims, username);

  const session: vscode.AuthenticationSession = {
    id: SESSION_ID,
    accessToken,
    account,
    scopes: ['platform'],
  };

  sessionMetadata.set(SESSION_ID, { userHeader });
  automationSessionCache = session;
  return session;
}

async function loadSessionFromWorkspaceFile(): Promise<{ token: string; email?: string } | undefined> {
  const candidates = new Set<string>();
  const explicit = process.env.AEGIS_WORKSPACE_OUTPUT?.trim();
  if (explicit) {
    candidates.add(explicit);
  }
  candidates.add(path.resolve(__dirname, '..', '__tests__', 'e2e-real', '.workspace-session.json'));

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { user_token?: string | null; user_email?: string | null };
      const token = parsed.user_token?.trim();
      if (token) {
        return { token, email: parsed.user_email ?? undefined };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[auth] failed to read workspace session file', candidate, err);
      }
    }
  }
  return undefined;
}

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

function normalizeClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function deriveAccountInfo(claims: Record<string, unknown> | undefined, fallbackSubject?: string) {
  const subject =
    normalizeClaim(claims?.sub) ||
    normalizeClaim(fallbackSubject) ||
    'aegis-user';
  const email = normalizeClaim(claims?.email);
  const preferredUsername = normalizeClaim(claims?.preferred_username);
  const friendlyName = normalizeClaim(claims?.name);
  const label = email || preferredUsername || friendlyName || subject;
  const userHeader = email || preferredUsername || subject;
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

    if (isSecureMode()) {
      // In secure mode, only use in-memory sessions — do not read from SecretStorage
      return undefined;
    }

    const raw = await this.context.secrets.get(SECRET_SESSION_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedSession;
        if (parsed && typeof parsed.accessToken === 'string') {
          // Validate that the persisted token was issued by the currently configured authority
          const claims = parseJwt(parsed.accessToken);
          const { auth } = getSettings();
          const configuredIssuer = auth.authority?.replace(/\/+$/u, '');
          if (claims?.iss && configuredIssuer && claims.iss !== configuredIssuer) {
            console.warn('[auth] persisted token issuer mismatch — clearing stale session');
            await this.context.secrets.delete(SECRET_SESSION_KEY);
            return undefined;
          }
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
    if (isSecureMode()) {
      // In secure mode, keep tokens in-memory only — do not persist to SecretStorage
      return;
    }
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
        const refreshed = await withRetry(
          () => this.refreshTokens(persisted.refreshToken!, persisted.scope),
          { maxRetries: 3, baseDelayMs: 1000, label: 'token refresh' },
        );
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

    let filteredScopes = scopes;
    if (isSecureMode()) {
      filteredScopes = scopes.filter((s) => s !== 'offline_access');
    }

    const scope = buildScope(filteredScopes, auth.scopes, platform?.authScope);
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
        reject(
          new Error(
            'OAuth login timed out waiting for callback. If Keycloak showed "Restart login cookie not found", allow cookies for your Keycloak host or sign in with AEGIS_TEST_USERNAME/AEGIS_TEST_PASSWORD env vars.'
          )
        );
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
      refreshToken: isSecureMode() ? undefined : tokenResponse.refresh_token,
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
  // In dev/test mode, prioritize password grant over potentially stale persisted sessions
  if (process.env.AEGIS_TEST_USERNAME && createIfNone) {
    const automated = await automationSessionFromEnv();
    if (automated) {
      return automated;
    }
  }

  let existing: vscode.AuthenticationSession | undefined;
  try {
    existing = await vscode.authentication.getSession(AUTH_PROVIDER_ID, ['platform'], {
      createIfNone: false,
      silent: true,
    });
  } catch {
    existing = undefined;
  }
  if (existing) {
    return existing;
  }

  if (createIfNone && !process.env.AEGIS_TEST_USERNAME) {
    const automated = await automationSessionFromEnv();
    if (automated) {
      return automated;
    }
  }

  try {
    return await vscode.authentication.getSession(AUTH_PROVIDER_ID, ['platform'], { createIfNone });
  } catch (err) {
    if (
      createIfNone &&
      err instanceof Error &&
      /DialogService: refused to show dialog in tests/.test(err.message)
    ) {
      const existing = await vscode.authentication.getSession(AUTH_PROVIDER_ID, ['platform'], {
        createIfNone: false,
        silent: true,
      });
      if (existing) {
        return existing;
      }
      return automationSessionFromEnv();
    }
    throw err;
  }
}

export async function signOut() {
  automationSessionCache = undefined;
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

/**
 * Delete all known secret keys from VS Code SecretStorage.
 * Called during deactivate() in secure mode to ensure no tokens persist on disk.
 */
export async function clearAllSecrets(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_SESSION_KEY);
  await context.secrets.delete(LEGACY_SECRET_TOKEN_KEY);
  await context.secrets.delete(LEGACY_SECRET_SUBJECT_KEY);
  automationSessionCache = undefined;
  out.appendLine('[auth] all secrets cleared');
}
