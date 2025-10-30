/* eslint-disable no-console */
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { performKeycloakLogin } from '../__tests__/e2e-real/suite/lib/keycloak-login';

const execFileAsync = promisify(execFile);

type PlatformClient = grpc.Client & Record<string, unknown>;

interface ProjectPolicy {
  regions: string[];
  data_level?: string;
  deny_egress_by_default?: boolean;
}

export interface WorkspaceSessionDetails {
  workspace_id: string;
  project_id: string;
  proxy_url: string;
  jwt: string;
  ca_pem?: string | null;
  ca_file?: string | null;
  namespace?: string | null;
  cluster_id?: string | null;
  session_id?: string | null;
  vscode_uri?: string | null;
  expires_at_utc?: string | null;
  user_email?: string | null;
  user_token?: string | null;
  metadata: {
    grpc_addr: string;
    queue?: string;
    flavor?: string;
    image?: string;
    created_at: string;
    ready_timeout_ms: number;
    poll_interval_ms: number;
  };
}

export interface PrepareOptions {
  grpcAddr: string;
  token: string;
  email?: string;
  namespace?: string;
  projectId: string;
  projectDisplayName?: string;
  projectOwnerGroup?: string;
  projectPolicy: ProjectPolicy;
  queue: string;
  flavor: string;
  image: string;
  workspaceCommand?: string[];
  workspaceEnv: Record<string, string>;
  workspaceId?: string;
  workspaceIdPrefix: string;
  outputPath: string;
  caPath?: string;
  caInline?: string;
  skipTls: boolean;
  readyTimeoutMs: number;
  pollIntervalMs: number;
  submitAttempts: number;
  submitRetryDelayMs: number;
  clusterId?: string;
  clusterRegistration?: {
    provider?: string;
    region?: string;
    ilLevel?: string;
    labels?: Record<string, string>;
    availableFlavors?: { name: string }[];
    ttfGpuSecondsP50?: number;
  };
  sessionClientId: string;
  debugLogs: boolean;
  caOutputPath: string;
  allowCleanupHook: boolean;
  readyStabilizationMs: number;
}

export interface PrepareResult {
  session: WorkspaceSessionDetails;
  cleanup: () => Promise<void>;
}

export interface WorkloadSummary {
  id?: string | null;
  status?: string | null;
  project_id?: string | null;
}

interface CliOverrides {
  outputPath?: string;
  workspaceId?: string;
  workspaceImage?: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  workspacePrefix?: string;
  mode?: 'prepare' | 'cleanup' | 'list' | 'token';
  sessionFile?: string;
}

interface ListWorkloadsResult {
  items?: WorkloadSummary[];
}

const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, '../__tests__/e2e-real/.workspace-session.json');
const DEFAULT_CA_OUTPUT_PATH = path.resolve(__dirname, '../__tests__/e2e-real/.workspace-ca.pem');
const PROTO_PATH = path.resolve(__dirname, '../proto/aegis_platform.proto');

function parseArgs(argv: string[]): CliOverrides {
  const overrides: CliOverrides = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const [flag, valueFromEquals] = arg.split('=', 2);
    let nextValue: string | undefined = valueFromEquals;
    if (nextValue === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      nextValue = argv[i + 1];
      i += 1;
    }
    switch (flag) {
      case '--output':
        overrides.outputPath = nextValue || DEFAULT_OUTPUT_PATH;
        break;
      case '--workspace-id':
        overrides.workspaceId = nextValue;
        break;
      case '--workspace-image':
        overrides.workspaceImage = nextValue;
        break;
      case '--ready-timeout-ms':
        overrides.readyTimeoutMs = nextValue ? Number.parseInt(nextValue, 10) : undefined;
        break;
      case '--poll-interval-ms':
        overrides.pollIntervalMs = nextValue ? Number.parseInt(nextValue, 10) : undefined;
        break;
      case '--workspace-prefix':
        overrides.workspacePrefix = nextValue;
        break;
      case '--cleanup':
        overrides.mode = 'cleanup';
        overrides.sessionFile = nextValue;
        break;
      case '--mode':
        if (nextValue === 'cleanup' || nextValue === 'list' || nextValue === 'token') {
          overrides.mode = nextValue as CliOverrides['mode'];
        } else {
          overrides.mode = 'prepare';
        }
        break;
      case '--session-file':
        overrides.sessionFile = nextValue;
        break;
      default:
        break;
    }
  }
  return overrides;
}

function parseDurationMs(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.endsWith('ms')) {
    const numeric = Number(trimmed.slice(0, -2));
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  if (trimmed.endsWith('s')) {
    const numeric = Number(trimmed.slice(0, -1));
    return Number.isFinite(numeric) ? numeric * 1000 : fallback;
  }
  if (trimmed.endsWith('m')) {
    const numeric = Number(trimmed.slice(0, -1));
    return Number.isFinite(numeric) ? numeric * 60_000 : fallback;
  }
  if (trimmed.endsWith('h')) {
    const numeric = Number(trimmed.slice(0, -1));
    return Number.isFinite(numeric) ? numeric * 3_600_000 : fallback;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn('[prepare-real-workspace] failed to parse JSON value:', err);
    return undefined;
  }
}

interface AutomationAuthResult {
  token: string;
  email?: string;
  subject?: string;
  idToken?: string;
  refreshToken?: string;
}

interface DerivedAccountInfo {
  account: { id: string; label: string };
  userHeader: string;
}

let cachedAutomationAuth: Promise<AutomationAuthResult> | undefined;

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(crypto.randomBytes(32));
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function parseJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
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
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function deriveAccountInfo(claims: Record<string, unknown> | undefined, fallbackSubject?: string): DerivedAccountInfo {
  const subject =
    (typeof claims?.sub === 'string' && claims.sub) ||
    (fallbackSubject && fallbackSubject.trim()) ||
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
  return {
    account: { id: subject, label },
    userHeader,
  };
}

function normalizeScopes(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function buildScope(base: string[], audience?: string, extras: string[] = []): string {
  const scopeSet = new Set<string>();
  for (const value of base) {
    const trimmed = value.trim();
    if (trimmed) {
      scopeSet.add(trimmed);
    }
  }
  for (const value of extras) {
    const trimmed = value.trim();
    if (trimmed) {
      scopeSet.add(trimmed);
    }
  }
  if (audience && audience.trim()) {
    scopeSet.add(audience.trim());
  }
  if (scopeSet.size === 0) {
    return 'openid';
  }
  return Array.from(scopeSet).join(' ');
}

function resolveAuthorityBase(raw: string): string {
  return raw.replace(/\/+$/u, '');
}

async function resolveAutomationAuth(env: NodeJS.ProcessEnv, debugLogs: boolean): Promise<AutomationAuthResult> {
  if (!cachedAutomationAuth) {
    cachedAutomationAuth = (async () => {
      const username = env.AEGIS_TEST_USERNAME?.trim();
      const password = env.AEGIS_TEST_PASSWORD ?? '';
      if (!username || !password) {
        throw new Error(
          'Provide AEGIS_TEST_USERNAME and AEGIS_TEST_PASSWORD so the automation can sign in.'
        );
      }

      const authority = resolveAuthorityBase(env.AEGIS_AUTH_AUTHORITY?.trim() || 'https://keycloak.localtest.me/realms/aegis');
      const clientId = env.AEGIS_AUTH_CLIENT_ID?.trim() || 'vscode-extension';
      const redirectUri = env.AEGIS_AUTH_REDIRECT_URI?.trim() || 'vscode://aegis.aegis-remote/auth';
      const prompt = env.AEGIS_AUTH_PROMPT?.trim();
      const loginHint = env.AEGIS_AUTH_LOGIN_HINT?.trim() || username;
      const audienceParam = env.AEGIS_AUTH_AUDIENCE?.trim();
      const loginTimeoutMs = parseDurationMs(env.AEGIS_AUTH_LOGIN_TIMEOUT_MS || env.AEGIS_AUTH_LOGIN_TIMEOUT, 120_000);
      const skipTlsRequested = [env.AEGIS_TLS_SKIP_VERIFY, env.AEGIS_AUTH_TLS_SKIP_VERIFY]
        .map((value) => (value ?? '').trim().toLowerCase())
        .some((value) => value === '1' || value === 'true' || value === 'yes');

      if (skipTlsRequested) {
        throw new Error(
          'TLS verification is required for real-backend tests. Remove AEGIS_TLS_SKIP_VERIFY / AEGIS_AUTH_TLS_SKIP_VERIFY and ensure the trust bundle is present.'
        );
      }

      const baseScopes = normalizeScopes(env.AEGIS_AUTH_SCOPES);
      if (baseScopes.length === 0) {
        baseScopes.push('openid', 'profile', 'email', 'offline_access');
      }
      const extraScopes = [
        ...normalizeScopes(env.AEGIS_AUTH_ADDITIONAL_SCOPES),
        ...normalizeScopes(env.AEGIS_AUTH_REQUESTED_SCOPES),
        ...normalizeScopes(env.AEGIS_AUTH_EXTRA_SCOPES),
      ];
      const audience = env.AEGIS_PLATFORM_AUTH_SCOPE?.trim()
        || env.AEGIS_AUTH_SCOPE?.trim()
        || env.AEGIS_PLATFORM_AUTH_AUDIENCE?.trim();
      const scope = buildScope(baseScopes, audience, extraScopes);

      const { verifier, challenge } = createPkcePair();
      const state = toBase64Url(crypto.randomBytes(18));

      const authUrl = new URL(`${authority}/protocol/openid-connect/auth`);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      if (prompt) {
        authUrl.searchParams.set('prompt', prompt);
      }
      if (loginHint) {
        authUrl.searchParams.set('login_hint', loginHint);
      }
      if (audienceParam) {
        authUrl.searchParams.set('audience', audienceParam);
      }

      if (debugLogs) {
        console.log('[prepare-real-workspace] acquiring automation token via Keycloak login');
      }

      const { redirectUri: returnedUri } = await performKeycloakLogin(authUrl.toString(), {
        username,
        password,
        totpSecret: env.AEGIS_TEST_TOTP_SECRET,
        loginTimeoutMs,
      });

      if (!returnedUri) {
        throw new Error('Keycloak login did not yield a redirect URI');
      }
      const parsedRedirect = new URL(returnedUri);
      const returnedState = parsedRedirect.searchParams.get('state') ?? '';
      if (returnedState && returnedState !== state) {
        throw new Error('Keycloak login returned an unexpected state value');
      }
      const code = parsedRedirect.searchParams.get('code');
      if (!code) {
        throw new Error('Authorization redirect missing code parameter');
      }

      const tokenUrl = `${authority}/protocol/openid-connect/token`;
      const body = new URLSearchParams();
      body.set('grant_type', 'authorization_code');
      body.set('code', code);
      body.set('redirect_uri', redirectUri);
      body.set('client_id', clientId);
      body.set('code_verifier', verifier);
      if (scope) {
        body.set('scope', scope);
      }

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Keycloak token exchange failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`
        );
      }

      type TokenResponse = {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        scope?: string;
        expires_in?: number | string;
      };

      const tokenResponse = (await response.json()) as TokenResponse;
      const accessToken = tokenResponse.access_token?.trim();
      if (!accessToken) {
        throw new Error('Keycloak token exchange did not return access_token');
      }
      const idToken = tokenResponse.id_token?.trim();
      const claims = parseJwtClaims(idToken) ?? parseJwtClaims(accessToken);
      const derived = deriveAccountInfo(claims, username);
      const resolvedEmail = env.AEGIS_TEST_EMAIL?.trim() || derived.userHeader || username;

      if (debugLogs) {
        console.log('[prepare-real-workspace] obtained automation token via Keycloak login');
      }

      return {
        token: accessToken,
        email: resolvedEmail,
        subject: derived.account.id,
        idToken,
        refreshToken: tokenResponse.refresh_token?.trim(),
      };
    })().catch((err) => {
      cachedAutomationAuth = undefined;
      throw err;
    });
  }

  return cachedAutomationAuth;
}

function buildWorkspaceId(prefix: string): string {
  const random = crypto.randomBytes(4).toString('hex');
  const ts = Date.now().toString(36);
  return `${prefix}${ts}-${random}`;
}

async function ensureDirForFile(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function resolveVsCodeCommit(quality: string, debugLogs: boolean): Promise<string | undefined> {
  try {
    const root = await downloadAndUnzipVSCode(quality);
    if (debugLogs) {
      console.log('[prepare-real-workspace] vscode download root', root);
    }
    const candidates = [
      path.join(root, 'resources', 'app', 'product.json'),
      path.join(root, 'Contents', 'Resources', 'app', 'product.json'),
      path.resolve(root, '..', 'Resources', 'app', 'product.json'),
      path.resolve(root, '..', '..', 'Resources', 'app', 'product.json'),
      path.resolve(root, '..', '..', 'resources', 'app', 'product.json'),
      path.resolve(root, '..', '..', '..', 'resources', 'app', 'product.json'),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const product = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { commit?: string };
      if (product?.commit) {
        if (debugLogs) {
          console.log('[prepare-real-workspace] resolved VS Code commit', product.commit);
        }
        return product.commit;
      }
    }

    const binaries = [
      root,
      path.join(path.dirname(root), 'bin', 'code'),
      path.join(root, 'bin', 'code'),
      path.join(root, 'code'),
      path.join(root, 'Contents', 'Resources', 'app', 'bin', 'code'),
      path.join(root, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
    ];
    const seen = new Set<string>();
    for (const candidate of binaries) {
      const binary = path.normalize(candidate);
      if (seen.has(binary)) {
        continue;
      }
      seen.add(binary);
      if (!fs.existsSync(binary)) {
        continue;
      }
      try {
        const stat = fs.statSync(binary);
        if (!stat.isFile()) {
          continue;
        }
      } catch (err) {
        if (debugLogs) {
          console.warn('[prepare-real-workspace] failed to stat possible vscode binary', binary, err);
        }
        continue;
      }
      try {
        const { stdout } = await execFileAsync(binary, ['--version']);
        const lines = stdout.trim().split(/\r?\n/);
        const commitLine = lines[1]?.trim();
        if (commitLine && /^[0-9a-f]{40}$/i.test(commitLine)) {
          if (debugLogs) {
            console.log('[prepare-real-workspace] resolved VS Code commit via binary', commitLine);
          }
          return commitLine;
        }
      } catch (err) {
        if (debugLogs) {
          console.warn('[prepare-real-workspace] failed to resolve commit via binary', binary, err);
        }
      }
    }
  } catch (err) {
    if (debugLogs) {
      console.warn('[prepare-real-workspace] failed to resolve VS Code commit:', err);
    }
  }
  return undefined;
}

async function loadPlatformClient(opts: PrepareOptions): Promise<PlatformClient> {
  const packageDefinition = await protoLoader.load(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as Record<string, any>;
  const namespace = loaded?.aegis?.v1;
  if (!namespace) {
    throw new Error('Failed to load aegis.v1 namespace from proto definition');
  }
  const ctor = namespace.AegisPlatform ?? namespace.AegisPlatformService ?? namespace.PlatformService;
  if (typeof ctor !== 'function') {
    throw new Error('AegisPlatform service constructor not found in loaded proto definition');
  }

  let credentials: grpc.ChannelCredentials;
  if (opts.skipTls) {
    credentials = grpc.credentials.createInsecure();
  } else if (opts.caInline) {
    credentials = grpc.credentials.createSsl(Buffer.from(opts.caInline));
  } else if (opts.caPath) {
    try {
      const ca = await fsp.readFile(opts.caPath);
      credentials = grpc.credentials.createSsl(ca);
    } catch (err) {
      console.warn('[prepare-real-workspace] failed to read CA bundle; falling back to default TLS roots', err);
      credentials = grpc.credentials.createSsl();
    }
  } else {
    credentials = grpc.credentials.createSsl();
  }

  const client = new ctor(opts.grpcAddr, credentials, {
    'grpc.max_receive_message_length': 10 * 1024 * 1024,
  }) as PlatformClient;

  const deadline = Date.now() + 30_000;
  await new Promise<void>((resolve, reject) => {
    client.waitForReady(deadline, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  return client;
}

function buildMetadata(opts: PrepareOptions): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.add('authorization', `Bearer ${opts.token}`);
  if (opts.namespace) {
    metadata.add('x-aegis-namespace', opts.namespace);
  }
  return metadata;
}

async function callUnary<TResponse>(
  client: PlatformClient,
  methodName: string,
  request: Record<string, unknown>,
  metadata: grpc.Metadata
): Promise<TResponse> {
  const method = client[methodName] as ((
    req: Record<string, unknown>,
    meta: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, response: TResponse) => void
  ) => void) | undefined;
  if (!method) {
    throw new Error(`Method ${methodName} not found on AegisPlatform client`);
  }
  return new Promise<TResponse>((resolve, reject) => {
    method.call(client, request, metadata, (err, response) => {
      if (err) {
        reject(err);
      } else {
        resolve(response);
      }
    });
  });
}

class WorkspaceManager {
  private client: PlatformClient | undefined;

  private metadata: grpc.Metadata | undefined;

  private session: WorkspaceSessionDetails | undefined;

  private workspaceId: string;

  private cleanupRegistered = false;

  private cleaningUp = false;

  constructor(private readonly opts: PrepareOptions) {
    this.workspaceId = opts.workspaceId ?? buildWorkspaceId(opts.workspaceIdPrefix);
  }

  async prepare(): Promise<PrepareResult> {
    this.client = await loadPlatformClient(this.opts);
    this.metadata = buildMetadata(this.opts);

    await this.ensureProject();
    await this.ensureFlavor();
    await this.ensureQueue();
    await this.ensureCluster();
    await this.cleanupStaleWorkspaces();

    await this.submitWorkspace();
    await this.waitForRunning();
    const session = await this.createSession();
    await this.persistSession(session);

    if (this.opts.allowCleanupHook) {
      this.registerCleanupHook();
    }

    const cleanup = async () => {
      await this.cleanup();
    };

    return { session, cleanup };
  }

  getSession(): WorkspaceSessionDetails | undefined {
    return this.session;
  }

  private async ensureProject(): Promise<void> {
    if (!this.client || !this.metadata) {
      throw new Error('gRPC client not initialized');
    }
    try {
      await callUnary(this.client, 'CreateProject', {
        project: {
          id: this.opts.projectId,
          display_name: this.opts.projectDisplayName || this.opts.projectId,
          owner_group: this.opts.projectOwnerGroup || 'aegis-dev',
          policy: this.opts.projectPolicy,
        },
      }, this.metadata);
      if (this.opts.debugLogs) {
        console.log('[prepare-real-workspace] ensured project', this.opts.projectId);
      }
    } catch (err) {
      const error = err as grpc.ServiceError;
      if (error?.code === grpc.status.ALREADY_EXISTS) {
        return;
      }
      throw err;
    }
  }

  private async ensureFlavor(): Promise<void> {
    if (!this.client || !this.metadata) {
      throw new Error('gRPC client not initialized');
    }
    try {
      await callUnary(this.client, 'UpsertFlavor', {
        flavor: { name: this.opts.flavor },
      }, this.metadata);
    } catch (err) {
      const error = err as grpc.ServiceError;
      if (error?.code !== grpc.status.ALREADY_EXISTS) {
        throw err;
      }
    }
  }

  private async ensureQueue(): Promise<void> {
    if (!this.client || !this.metadata) {
      throw new Error('gRPC client not initialized');
    }
    try {
      await callUnary(this.client, 'UpsertQueue', {
        queue: {
          name: this.opts.queue,
          project_id: this.opts.projectId,
          allowed_flavors: [this.opts.flavor],
        },
      }, this.metadata);
    } catch (err) {
      const error = err as grpc.ServiceError;
      if (error?.code !== grpc.status.ALREADY_EXISTS) {
        throw err;
      }
    }
  }

  private async ensureCluster(): Promise<void> {
    if (!this.client || !this.metadata || !this.opts.clusterId || !this.opts.clusterRegistration) {
      return;
    }

    try {
      await callUnary(this.client, 'RegisterCluster', {
        cluster_id: this.opts.clusterId,
        provider: this.opts.clusterRegistration.provider || 'aws',
        region: this.opts.clusterRegistration.region || 'us-east-1',
        il_level: this.opts.clusterRegistration.ilLevel || 'il1',
        labels: this.opts.clusterRegistration.labels || {},
      }, this.metadata);
    } catch (err) {
      const error = err as grpc.ServiceError;
      if (error?.code !== grpc.status.ALREADY_EXISTS) {
        throw err;
      }
    }

    await callUnary(this.client, 'Heartbeat', {
      cluster_id: this.opts.clusterId,
      available_flavors: this.opts.clusterRegistration.availableFlavors || [{ name: this.opts.flavor }],
      ttf_gpu_seconds_p50: this.opts.clusterRegistration.ttfGpuSecondsP50,
    }, this.metadata);
  }

  private async cleanupStaleWorkspaces(): Promise<void> {
    if (!this.client || !this.metadata) {
      return;
    }
    try {
      const list = await callUnary<{ items?: Array<{ id?: string }> }>(
        this.client,
        'ListWorkloads',
        { project_id: this.opts.projectId },
        this.metadata,
      );
      const items = list?.items ?? [];
      for (const item of items) {
        const wid = item?.id ?? '';
        if (!wid) {
          continue;
        }
        if (wid === this.workspaceId || wid.startsWith(this.opts.workspaceIdPrefix)) {
          try {
            await callUnary(this.client, 'AckWorkload', {
              id: wid,
              status: 'FAILED',
              backend: 'vscode-e2e-cleanup',
            }, this.metadata);
            if (this.opts.debugLogs) {
              console.log('[prepare-real-workspace] acknowledged stale workspace', wid);
            }
          } catch (err) {
            if (this.opts.debugLogs) {
              console.warn('[prepare-real-workspace] failed to acknowledge stale workspace', wid, err);
            }
          }
        }
      }
    } catch (err) {
      if (this.opts.debugLogs) {
        console.warn('[prepare-real-workspace] ListWorkloads failed:', err);
      }
    }
  }

  private async submitWorkspace(): Promise<void> {
    if (!this.client || !this.metadata) {
      throw new Error('gRPC client not initialized');
    }
    const workspaceSpec: Record<string, unknown> = {
      interactive: true,
      flavor: this.opts.flavor,
      image: this.opts.image,
      ports: [11111],
      env: this.opts.workspaceEnv,
    };
    if (this.opts.workspaceCommand && this.opts.workspaceCommand.length > 0) {
      workspaceSpec.command = this.opts.workspaceCommand;
    }

    const payload: Record<string, unknown> = {
      workload: {
        id: this.workspaceId,
        project_id: this.opts.projectId,
        queue: this.opts.queue,
        cluster_id: this.opts.clusterId,
        workspace: workspaceSpec,
      },
    };

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await callUnary(this.client, 'SubmitWorkload', payload, this.metadata);
        if (this.opts.debugLogs) {
          console.log('[prepare-real-workspace] submitted workload', this.workspaceId);
        }
        break;
      } catch (err) {
        const error = err as grpc.ServiceError;
        const isClusterClientError = Boolean(
          error?.code === grpc.status.INTERNAL
          && typeof error?.details === 'string'
          && error.details.includes('failed to resolve cluster client'),
        );
        if (!isClusterClientError || attempt >= this.opts.submitAttempts) {
          throw err;
        }
        const delay = Math.max(this.opts.submitRetryDelayMs, 1000);
        if (this.opts.debugLogs) {
          console.log('[prepare-real-workspace] retrying SubmitWorkload after error:', error?.details || error?.message);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async waitForRunning(): Promise<void> {
    if (!this.client || !this.metadata) {
      throw new Error('gRPC client not initialized');
    }
    const deadline = Date.now() + Math.max(this.opts.readyTimeoutMs, 1000);
    let loggedStatus = false;
    while (Date.now() < deadline) {
      try {
        const workload = await callUnary<Record<string, any>>(this.client, 'GetWorkload', { id: this.workspaceId }, this.metadata);
        const status = (workload?.status ?? '').toUpperCase();
        if (status === 'RUNNING') {
          if (this.opts.readyStabilizationMs > 0) {
            if (this.opts.debugLogs) {
              console.log('[prepare-real-workspace] workspace RUNNING, waiting extra', this.opts.readyStabilizationMs, 'ms for stabilization');
            }
            await new Promise((resolve) => setTimeout(resolve, this.opts.readyStabilizationMs));
          }
          return;
        }
        if (status === 'FAILED') {
          throw new Error(`Workspace ${this.workspaceId} failed before reaching RUNNING status`);
        }
        if (!loggedStatus && this.opts.debugLogs) {
          console.log('[prepare-real-workspace] waiting for workspace status; current status:', status || 'UNKNOWN');
          loggedStatus = true;
        }
      } catch (err) {
        if (this.opts.debugLogs) {
          console.warn('[prepare-real-workspace] polling workspace status failed:', err);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(this.opts.pollIntervalMs, 1000)));
    }
    throw new Error(`Timed out waiting for workspace ${this.workspaceId} to reach RUNNING status`);
  }

  private async createSession(): Promise<WorkspaceSessionDetails> {
    if (!this.client || !this.metadata) {
      throw new Error('gRPC client not initialized');
    }
    const response = await callUnary<Record<string, unknown>>(
      this.client,
      'CreateConnectionSession',
      { workload_id: this.workspaceId, client: this.opts.sessionClientId },
      this.metadata,
    );

    const proxyUrl = typeof response?.proxy_url === 'string' ? response.proxy_url : '';
    const token = typeof response?.token === 'string' ? response.token : '';
    if (!proxyUrl || !token) {
      throw new Error('CreateConnectionSession response missing proxy_url or token');
    }

    if (this.opts.debugLogs) {
      console.log('[prepare-real-workspace] obtained proxy ticket', proxyUrl);
    }

    const caContent = await this.resolveCaPem();
    let caFile: string | null = null;
    if (caContent) {
      await ensureDirForFile(this.opts.caOutputPath);
      await fsp.writeFile(this.opts.caOutputPath, caContent, 'utf8');
      caFile = this.opts.caOutputPath;
    }

    const session: WorkspaceSessionDetails = {
      workspace_id: this.workspaceId,
      project_id: this.opts.projectId,
      proxy_url: proxyUrl,
      jwt: token,
      ca_pem: caContent,
      ca_file: caFile,
      namespace: this.opts.namespace,
      cluster_id: this.opts.clusterId,
      user_email: this.opts.email,
      user_token: this.opts.token,
      session_id: typeof response?.session_id === 'string' ? response.session_id : undefined,
      vscode_uri: typeof response?.vscode_uri === 'string' ? response.vscode_uri : undefined,
      expires_at_utc: typeof response?.expires_at_utc === 'string' ? response.expires_at_utc : undefined,
      metadata: {
        grpc_addr: this.opts.grpcAddr,
        queue: this.opts.queue,
        flavor: this.opts.flavor,
        image: this.opts.image,
        created_at: new Date().toISOString(),
        ready_timeout_ms: this.opts.readyTimeoutMs,
        poll_interval_ms: this.opts.pollIntervalMs,
      },
    };

    this.session = session;
    return session;
  }

  private async resolveCaPem(): Promise<string | null> {
    if (this.opts.caInline) {
      return this.opts.caInline;
    }
    if (!this.opts.caPath) {
      return null;
    }
    try {
      const content = await fsp.readFile(this.opts.caPath, 'utf8');
      return content;
    } catch (err) {
      console.warn('[prepare-real-workspace] failed to read CA bundle from', this.opts.caPath, err);
      return null;
    }
  }

  private async persistSession(session: WorkspaceSessionDetails): Promise<void> {
    await ensureDirForFile(this.opts.outputPath);
    await fsp.writeFile(this.opts.outputPath, JSON.stringify(session, null, 2), 'utf8');
    if (this.opts.debugLogs) {
      console.log('[prepare-real-workspace] wrote session details to', this.opts.outputPath);
    }
  }

  private registerCleanupHook(): void {
    if (this.cleanupRegistered) {
      return;
    }
    this.cleanupRegistered = true;

    const cleanupWrapper = async () => {
      await this.cleanup();
    };

    process.on('exit', () => {
      cleanupWrapper().catch((err) => {
        console.error('[prepare-real-workspace] cleanup on exit failed:', err);
      });
    });

    const handleSignal = (signal: NodeJS.Signals) => {
      cleanupWrapper()
        .catch((err) => {
          console.error(`[prepare-real-workspace] cleanup on ${signal} failed:`, err);
        })
        .finally(() => {
          process.exit();
        });
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    process.once('SIGQUIT', handleSignal);
  }

  async cleanup(): Promise<void> {
    if (this.cleaningUp) {
      return;
    }
    this.cleaningUp = true;

    if (!this.client || !this.metadata) {
      return;
    }

    const statuses = ['DELETED', 'CANCELLED', 'FAILED', 'SUCCEEDED'];
    for (const status of statuses) {
      try {
        await callUnary(this.client, 'AckWorkload', {
          id: this.workspaceId,
          status,
          backend: 'vscode-e2e-cleanup',
        }, this.metadata);
        if (this.opts.debugLogs) {
          console.log('[prepare-real-workspace] acknowledged workspace', this.workspaceId, 'with status', status);
        }
        break;
      } catch (err) {
        const error = err as grpc.ServiceError;
        if (this.opts.debugLogs) {
          console.warn('[prepare-real-workspace] AckWorkload failed for status', status, error?.details || error?.message);
        }
      }
    }

    this.client.close();
  }
}

function parseWorkspaceCommand(raw: string | undefined, debugLogs: boolean): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
    if (debugLogs) {
      console.warn('[prepare-real-workspace] workspace command not an array of strings; falling back to default');
    }
    return undefined;
  } catch (err) {
    if (debugLogs) {
      console.warn('[prepare-real-workspace] failed to parse workspace command JSON; falling back to default', err);
    }
    return undefined;
  }
}

async function buildOptions(overrides: Partial<PrepareOptions>, cli: CliOverrides): Promise<PrepareOptions> {
  const env = process.env;

  const debugLogs = overrides.debugLogs ?? env.AEGIS_E2E_DEBUG === '1';

  const grpcAddr = overrides.grpcAddr
    ?? env.AEGIS_GRPC_ADDR
    ?? env.AEGIS_PLATFORM_GRPC_ADDR
    ?? env.AEGIS_PLATFORM_GRPC_ENDPOINT
    ?? 'platform-api-grpc.localtest.me:443';
  if (!grpcAddr) {
    throw new Error('AEGIS_GRPC_ADDR must be set');
  }
  env.AEGIS_GRPC_ADDR = grpcAddr;

  let token = overrides.token;
  let resolvedEmail: string | undefined;
  if (!token) {
    const automationAuth = await resolveAutomationAuth(env, debugLogs);
    token = automationAuth.token;
    resolvedEmail = automationAuth.email;
  }
  if (!token) {
    throw new Error('Failed to acquire automation access token for Platform API calls.');
  }

  const projectId = overrides.projectId ?? env.AEGIS_PROJECT_ID ?? 'p-demo';
  if (!projectId) {
    throw new Error('AEGIS_PROJECT_ID must be set');
  }
  env.AEGIS_PROJECT_ID = projectId;

  const workspaceEnv: Record<string, string> = {
    ...(parseJson<Record<string, string>>(env.AEGIS_TEST_WORKSPACE_ENV) ?? {}),
    ...(overrides.workspaceEnv ?? {}),
  };

  const workspaceCommand = overrides.workspaceCommand
    ?? parseWorkspaceCommand(env.AEGIS_TEST_WORKSPACE_COMMAND, debugLogs);

  const quality = (workspaceEnv.VSCODE_QUALITY || env.VSCODE_QUALITY || 'stable').toLowerCase();
  workspaceEnv.VSCODE_QUALITY = quality;
  let commit = workspaceEnv.VSCODE_COMMIT || env.VSCODE_COMMIT;
  if (!commit) {
    commit = await resolveVsCodeCommit(quality, debugLogs);
    if (!commit && debugLogs) {
      console.warn('[prepare-real-workspace] unable to resolve VS Code commit automatically');
    }
  }
  if (commit) {
    workspaceEnv.VSCODE_COMMIT = commit;
  }

  const queue = overrides.queue ?? env.AEGIS_TEST_QUEUE ?? 'default';
  const flavor = overrides.flavor ?? env.AEGIS_TEST_FLAVOR ?? 'cpu-small';
  const image = cli.workspaceImage ?? overrides.image ?? env.AEGIS_TEST_IMAGE
    ?? 'carlosmsanchez/aegis-workspace-vscode:latest';

  const readyTimeoutMs = overrides.readyTimeoutMs
    ?? cli.readyTimeoutMs
    ?? parseDurationMs(env.AEGIS_WORKSPACE_READY_TIMEOUT_MS || env.AEGIS_TEST_WORKSPACE_TIMEOUT, 480_000);

  const pollIntervalMs = overrides.pollIntervalMs
    ?? cli.pollIntervalMs
    ?? parseDurationMs(env.AEGIS_WORKSPACE_READY_POLL_MS, 5_000);

  const submitAttempts = overrides.submitAttempts
    ?? Number.parseInt(env.AEGIS_WORKSPACE_SUBMIT_ATTEMPTS || '12', 10);
  const submitRetryDelayMs = overrides.submitRetryDelayMs
    ?? parseDurationMs(env.AEGIS_WORKSPACE_SUBMIT_DELAY_MS, 10_000);

  const readyStabilizationMs = overrides.readyStabilizationMs
    ?? parseDurationMs(env.AEGIS_WORKSPACE_READY_STABILIZE_MS, 25_000);

  const workspaceIdPrefix = cli.workspacePrefix
    ?? overrides.workspaceIdPrefix
    ?? env.AEGIS_WORKSPACE_ID_PREFIX
    ?? 'w-vscode-e2e-';

  const outputPath = cli.outputPath
    ?? overrides.outputPath
    ?? env.AEGIS_WORKSPACE_OUTPUT
    ?? DEFAULT_OUTPUT_PATH;

  const homeTrustPath = path.resolve(os.homedir(), 'aegis-local-trust.pem');
  const defaultCaPath = fs.existsSync(homeTrustPath) ? homeTrustPath : undefined;

  const resolvedCaPath = overrides.caPath ?? env.AEGIS_CA_PEM?.trim() ?? defaultCaPath;
  const caInline = overrides.caInline ?? env.AEGIS_CA_PEM_INLINE?.trim();
  const caOutputPath = overrides.caOutputPath ?? DEFAULT_CA_OUTPUT_PATH;

  if (!resolvedCaPath) {
    throw new Error(
      `TLS trust bundle not found. Expected ${homeTrustPath}. Run "make deploy-local-tls" in the aegis repo to regenerate certificates.`
    );
  }
  if (!fs.existsSync(resolvedCaPath)) {
    throw new Error(
      `TLS trust bundle not found at ${resolvedCaPath}. Run "make deploy-local-tls" in the aegis repo to regenerate certificates.`
    );
  }

  const caPath = resolvedCaPath;

  if (!env.AEGIS_CA_PEM) {
    env.AEGIS_CA_PEM = caPath;
  }

  if (overrides.skipTls) {
    throw new Error('Real-backend tests require TLS. Remove skipTls overrides.');
  }

  const skipTls = false;

  const policyRegions = (env.AEGIS_PROJECT_POLICY_REGIONS || 'us-east-1')
    .split(',')
    .map((region) => region.trim())
    .filter((region) => region.length > 0);

  const policy: ProjectPolicy = overrides.projectPolicy ?? {
    regions: policyRegions,
    data_level: env.AEGIS_PROJECT_POLICY_DATA_LEVEL || 'il1',
    deny_egress_by_default: env.AEGIS_PROJECT_POLICY_DENY_EGRESS === '1' || env.AEGIS_PROJECT_POLICY_DENY_EGRESS === 'true',
  };

  const clusterId = overrides.clusterId ?? env.AEGIS_TEST_CLUSTER_ID ?? undefined;
  const clusterRegistration = overrides.clusterRegistration ?? {
    provider: env.AEGIS_CLUSTER_PROVIDER || 'aws',
    region: env.AEGIS_CLUSTER_REGION || 'us-east-1',
    ilLevel: env.AEGIS_CLUSTER_IL_LEVEL || 'il1',
    labels: {
      env: env.AEGIS_PLATFORM_NAMESPACE || 'default',
      ...(parseJson<Record<string, string>>(env.AEGIS_CLUSTER_LABELS) ?? {}),
    },
    availableFlavors: [{ name: flavor }],
  };

  const allowCleanupHook = overrides.allowCleanupHook ?? true;

  if (resolvedEmail && !env.AEGIS_TEST_EMAIL) {
    env.AEGIS_TEST_EMAIL = resolvedEmail;
  }

  return {
    grpcAddr,
    token,
    email: overrides.email ?? env.AEGIS_TEST_EMAIL ?? resolvedEmail ?? env.AEGIS_WORKSPACE_EMAIL,
    namespace: overrides.namespace ?? env.AEGIS_PLATFORM_NAMESPACE ?? 'default',
    projectId,
    projectDisplayName: overrides.projectDisplayName ?? env.AEGIS_PROJECT_DISPLAY_NAME,
    projectOwnerGroup: overrides.projectOwnerGroup ?? env.AEGIS_PROJECT_OWNER_GROUP,
    projectPolicy: policy,
    queue,
    flavor,
    image,
    workspaceCommand,
    workspaceEnv,
    workspaceId: cli.workspaceId ?? overrides.workspaceId ?? env.AEGIS_WORKSPACE_ID ?? undefined,
    workspaceIdPrefix,
    outputPath,
    caPath,
    caInline,
    skipTls,
    readyTimeoutMs,
    pollIntervalMs,
    submitAttempts,
    submitRetryDelayMs,
    readyStabilizationMs,
    clusterId,
    clusterRegistration,
    sessionClientId: overrides.sessionClientId ?? env.AEGIS_SESSION_CLIENT_ID ?? 'vscode',
    debugLogs,
    caOutputPath,
    allowCleanupHook,
  };
}

export async function prepareRealWorkspace(
  overrides: Partial<PrepareOptions> = {},
  cliOverrides: CliOverrides = {},
): Promise<PrepareResult> {
  const options = await buildOptions(overrides, cliOverrides);
  const manager = new WorkspaceManager(options);
  try {
    return await manager.prepare();
  } catch (err) {
    try {
      await manager.cleanup();
    } catch (cleanupErr) {
      if (options.debugLogs) {
        console.warn('[prepare-real-workspace] cleanup after failure also failed:', cleanupErr);
      }
    }
    throw err;
  }
}

export async function cleanupWorkspace(
  session: WorkspaceSessionDetails,
  overrides: Partial<PrepareOptions> = {},
): Promise<void> {
  const options = await buildOptions({ ...overrides, workspaceId: session.workspace_id, allowCleanupHook: false }, {});
  const client = await loadPlatformClient(options);
  const metadata = buildMetadata(options);
  const statuses = ['DELETED', 'CANCELLED', 'FAILED', 'SUCCEEDED'];
  for (const status of statuses) {
    try {
      await callUnary(client, 'AckWorkload', {
        id: session.workspace_id,
        status,
        backend: 'vscode-e2e-cleanup',
      }, metadata);
      if (options.debugLogs) {
        console.log('[prepare-real-workspace] cleanup acknowledged workspace', session.workspace_id, 'with status', status);
      }
      break;
    } catch (err) {
      const error = err as grpc.ServiceError;
      if (options.debugLogs) {
        console.warn('[prepare-real-workspace] cleanup AckWorkload failed for status', status, error?.details || error?.message);
      }
    }
  }
  client.close();
}

export async function listProjectWorkloads(
  overrides: Partial<PrepareOptions> = {},
  cliOverrides: CliOverrides = {},
): Promise<WorkloadSummary[]> {
  const options = await buildOptions(overrides, cliOverrides);
  const client = await loadPlatformClient(options);
  const metadata = buildMetadata(options);
  try {
    const response = await callUnary<{ items?: WorkloadSummary[] }>(
      client,
      'ListWorkloads',
      { project_id: options.projectId },
      metadata,
    );
    return response?.items ?? [];
  } finally {
    client.close();
  }
}

export async function loadWorkspaceSession(sessionFile?: string): Promise<WorkspaceSessionDetails> {
  const filePath = sessionFile ?? DEFAULT_OUTPUT_PATH;
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw) as WorkspaceSessionDetails;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const mode = cli.mode ?? 'prepare';
  if (mode === 'cleanup') {
    const session = await loadWorkspaceSession(cli.sessionFile);
    await cleanupWorkspace(session, {});
    console.log('[prepare-real-workspace] cleaned workspace', session.workspace_id);
    return;
  }

  if (mode === 'token') {
    const debugLogs = process.env.AEGIS_E2E_DEBUG === '1';
    const authResult = await resolveAutomationAuth(process.env, debugLogs);
    const payload = {
      accessToken: authResult.token,
      email: authResult.email,
      subject: authResult.subject,
      idToken: authResult.idToken,
      refreshToken: authResult.refreshToken,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (mode === 'list') {
    const workloads = await listProjectWorkloads({ allowCleanupHook: false }, cli);
    const payload: ListWorkloadsResult = { items: workloads };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const { session } = await prepareRealWorkspace({ allowCleanupHook: false }, cli);
  console.log('[prepare-real-workspace] workspace prepared', session.workspace_id);
  console.log('[prepare-real-workspace] proxy URL', session.proxy_url);
  console.log('[prepare-real-workspace] session written to', cli.outputPath ?? DEFAULT_OUTPUT_PATH);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[prepare-real-workspace] failed:', err);
    process.exitCode = 1;
  });
}
