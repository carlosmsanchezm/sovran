import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as vscode from 'vscode';
import * as path from 'path';
import { getGrpcTargetOverrides } from './grpc-target';
import { getSettings, AegisSettings } from './config';
import { getSessionUser, requireSession, signOut } from './auth';
import { out } from './ui';
import { loadCombinedCAsBuffer } from './tls';
import { withRetry } from './errors';

interface WorkspaceMessage {
  id: string;
  name: string;
  cluster?: string;
  dns?: string;
  profile?: string;
  persona?: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  cluster?: string;
  dns?: string;
  profile?: string;
  persona?: string;
  status?: string;
  uiStatus?: string;
  workspaceRoot?: string;
}

export interface ProxyTicket {
  proxyUrl: string;
  jwt: string;
  ttlSeconds: number;
  caPem?: string;
  certPem?: string;
  keyPem?: string;
  serverName?: string;
  jti?: string;
  dest?: string;
  dns?: string[];
  groups?: string[];
  workspaceRoot?: string;
}

export interface ProxyTicketSummary {
  proxyUrl: string;
  expiresAt?: string;
  hasClientCert: boolean;
  jti?: string;
  dest?: string;
  serverName?: string;
}

export interface RenewedTicket {
  sessionId: string;
  jwt: string;
  proxyUrl: string;
  expiresAtUtc?: string;
  ttlSeconds: number;
}

let lastTicketSummary: ProxyTicketSummary | undefined;
let currentSessionId: string | undefined;

export function getLastProxyTicketSummary(): ProxyTicketSummary | undefined {
  return lastTicketSummary;
}

export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}

export function clearCurrentSessionId(): void {
  currentSessionId = undefined;
}

type ConnectionSessionResponse = {
  session_id?: string;
  token?: string;
  proxy_url?: string;
  ssh_user?: string;
  ssh_host_alias?: string;
  expires_at_utc?: string;
  ssh_config?: string;
  one_time?: boolean;
  jti?: string;
  proxy_ca_pem?: string;
  workspace_root?: string;
};

type PlatformClientGrpc = grpc.Client & {
  ListProjects(
    request: Record<string, never>,
    metadata: grpc.Metadata,
    callback: (
      err: grpc.ServiceError | null,
      response: { items?: Array<{ id?: string; display_name?: string }> }
    ) => void
  ): void;
  ListWorkloads(
    request: { project_id?: string },
    metadata: grpc.Metadata,
    callback: (
      err: grpc.ServiceError | null,
      response: { items?: any[] }
    ) => void
  ): void;
  CreateConnectionSession(
    request: { workload_id: string; client: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (
      err: grpc.ServiceError | null,
      response: ConnectionSessionResponse
    ) => void
  ): grpc.ClientUnaryCall;
  RenewConnectionSession(
    request: { session_id: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (
      err: grpc.ServiceError | null,
      response: ConnectionSessionResponse
    ) => void
  ): grpc.ClientUnaryCall;
  RevokeConnectionSession(
    request: { session_id: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (
      err: grpc.ServiceError | null,
      response: {}
    ) => void
  ): grpc.ClientUnaryCall;
};

function isUnauthenticatedError(err: unknown): boolean {
  const grpcErr = err as grpc.ServiceError | undefined;
  if (grpcErr?.code === grpc.status.UNAUTHENTICATED) {
    return true;
  }
  const message = grpcErr?.message ?? (err instanceof Error ? err.message : String(err));
  return /UNAUTHENTICATED|invalid bearer token|token audience not accepted/i.test(message);
}

/**
 * Fetch the platform's root CA certificate from the PKI endpoint.
 * Uses HTTPS with system CAs to validate the ingress certificate, then
 * returns the internal CA for subsequent gRPC/WebSocket trust.
 */
/**
 * Fetch the platform discovery document from the public HTTP endpoint.
 * No authentication required — returns only public metadata (endpoint URLs).
 * Uses system CAs to validate the ingress TLS certificate.
 */
export async function fetchDiscovery(platformUrl: string): Promise<{
  grpc_endpoint: string;
  auth?: { authority?: string; client_id?: string };
  pki?: { root_ca_url?: string };
} | undefined> {
  try {
    const url = `https://${platformUrl}/api/v1/discovery`;
    out.appendLine(`[discovery] fetching from ${url}`);

    const https = await import('https');
    return new Promise((resolve) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) {
          out.appendLine(`[discovery] fetch failed: HTTP ${res.statusCode}`);
          resolve(undefined);
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.grpc_endpoint) {
              out.appendLine(`[discovery] success: grpc=${parsed.grpc_endpoint}`);
              resolve(parsed);
            } else {
              out.appendLine(`[discovery] response missing grpc_endpoint`);
              resolve(undefined);
            }
          } catch (err) {
            out.appendLine(`[discovery] invalid JSON: ${String(err)}`);
            resolve(undefined);
          }
        });
      });
      req.on('error', (err) => {
        out.appendLine(`[discovery] error: ${String(err)}`);
        resolve(undefined);
      });
      req.on('timeout', () => {
        out.appendLine(`[discovery] timed out`);
        req.destroy();
        resolve(undefined);
      });
    });
  } catch (err) {
    out.appendLine(`[discovery] failed: ${String(err)}`);
    return undefined;
  }
}

export async function fetchPlatformRootCA(grpcEndpoint: string): Promise<string | undefined> {
  try {
    const host = grpcEndpoint.split(':')[0];
    const pkiUrl = `https://${host}/api/v1/pki/root-ca`;
    out.appendLine(`[platform] fetching root CA from ${pkiUrl}`);

    const https = await import('https');
    return new Promise<string | undefined>((resolve) => {
      const req = https.get(pkiUrl, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) {
          out.appendLine(`[platform] root CA fetch failed: HTTP ${res.statusCode}`);
          resolve(undefined);
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (data.includes('BEGIN CERTIFICATE')) {
            out.appendLine(`[platform] root CA fetched successfully (${data.length} bytes)`);
            resolve(data);
          } else {
            out.appendLine(`[platform] root CA response does not contain a certificate`);
            resolve(undefined);
          }
        });
      });
      req.on('error', (err) => {
        out.appendLine(`[platform] root CA fetch error: ${String(err)}`);
        resolve(undefined);
      });
      req.on('timeout', () => {
        out.appendLine(`[platform] root CA fetch timed out`);
        req.destroy();
        resolve(undefined);
      });
    });
  } catch (err) {
    out.appendLine(`[platform] root CA fetch failed: ${String(err)}`);
    return undefined;
  }
}

class PlatformClient {
  private client: PlatformClientGrpc | undefined;
  private settings: AegisSettings | undefined;
  private readonly protoPath: string;
  private cleanup?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.protoPath = path.join(context.extensionPath, 'proto', 'aegis_platform.proto');
  }

  async initialize() {
    await this.ensureClients();
  }

  async refreshSettings() {
    this.disposeClients();
    await this.ensureClients();
  }

  disposeClients() {
    if (this.client) {
      this.client.close();
    }
    this.client = undefined;
  }

  private async ensureClients() {
    const settings = getSettings();
    const endpoint = this.normalizeEndpoint(settings.platform.grpcEndpoint);
    if (!endpoint) {
      this.disposeClients();
      return;
    }
    if (this.client && this.settings &&
        this.normalizeEndpoint(this.settings.platform.grpcEndpoint) === endpoint &&
        this.settings.security.caPath === settings.security.caPath &&
        this.settings.platform.grpcServerName === settings.platform.grpcServerName) {
      return;
    }
    this.settings = settings;

    const packageDefinition = await protoLoader.load(this.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as any;
    const namespace = loaded.aegis?.v1;
    if (!namespace) {
      throw new Error('Failed to load platform proto definitions.');
    }

    const tlsCreds = await this.buildChannelCredentials(endpoint, settings);
    const targetOverrides = getGrpcTargetOverrides(endpoint);
    const clientOptions: grpc.ClientOptions = {
      'grpc.max_receive_message_length': 10 * 1024 * 1024,
    };
    const serverName = settings.platform.grpcServerName?.trim();
    if (serverName) {
      clientOptions['grpc.ssl_target_name_override'] = serverName;
      clientOptions['grpc.default_authority'] = serverName;
      out.appendLine(
        `[platform] gRPC client options: ssl_target_name_override=${serverName} default_authority=${serverName} (from grpcServerName setting)`
      );
    } else if (targetOverrides) {
      clientOptions['grpc.ssl_target_name_override'] = targetOverrides.sslTargetNameOverride;
      clientOptions['grpc.default_authority'] = targetOverrides.defaultAuthority;
      out.appendLine(
        `[platform] gRPC client options: ssl_target_name_override=${targetOverrides.sslTargetNameOverride} default_authority=${targetOverrides.defaultAuthority}`
      );
    } else {
      out.appendLine('[platform] gRPC client options: ssl_target_name_override not set (unparseable endpoint hostname)');
    }

    const serviceDef = namespace.AegisPlatform ?? namespace.AegisPlatformService ?? namespace.PlatformService;
    if (typeof serviceDef !== 'function') {
      throw new Error('AegisPlatform service constructor not found in loaded proto definition');
    }
    this.client = new serviceDef(endpoint, tlsCreds, clientOptions) as PlatformClientGrpc;

    // Log channel state for debugging
    const channel = (this.client as any).getChannel?.();
    if (channel) {
      const state = channel.getConnectivityState(false);
      out.appendLine(`[platform] gRPC channel initial state: ${state}`);
    }
  }

  private async buildChannelCredentials(endpoint: string, settings: AegisSettings): Promise<grpc.ChannelCredentials> {
    const { security } = settings;

    if (endpoint.startsWith('localhost') || endpoint.startsWith('127.0.0.1') || endpoint.startsWith('[::1]')) {
      if (security.caPath) {
        out.appendLine('[platform] creating secure gRPC client for local development (custom CA)');
        const combinedCA = await loadCombinedCAsBuffer(security.caPath);
        return grpc.credentials.createSsl(combinedCA);
      }
      out.appendLine('[platform] creating insecure gRPC client for local development');
      return grpc.credentials.createInsecure();
    }

    if (security.rejectUnauthorized === false) {
      out.appendLine('[platform] creating gRPC client with TLS (certificate verification disabled by settings)');
      const combinedCA = await loadCombinedCAsBuffer(security.caPath);
      return grpc.credentials.createSsl(
        combinedCA ?? undefined,
        undefined,
        undefined,
        { checkServerIdentity: () => undefined },
      );
    }

    // Use shared utility to combine system CAs with custom CA
    // See /docs/infrastructure-reference.md for why this is required
    const combinedCA = await loadCombinedCAsBuffer(security.caPath);
    out.appendLine('[platform] creating secure gRPC client');
    return grpc.credentials.createSsl(combinedCA);
  }

  private ensureSettingsPresent() {
    const endpoint = this.normalizeEndpoint(this.settings?.platform.grpcEndpoint ?? '');
    if (!endpoint) {
      throw new Error('Configure "aegisRemote.platform.grpcEndpoint" in settings.');
    }
  }

  private normalizeEndpoint(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.endsWith('[')) {
      const sanitized = trimmed.slice(0, -1);
      out.appendLine(`[platform] normalized gRPC endpoint from "${trimmed}" to "${sanitized}"`);
      return sanitized;
    }

    return trimmed;
  }

  async listProjects(): Promise<Array<{ id: string; displayName: string }>> {
    this.ensureSettingsPresent();
    await this.ensureClients();
    if (!this.client) {
      return [];
    }
    const session = await requireSession(true);
    if (!session) {
      throw new Error('Aegis sign-in required.');
    }
    return new Promise<Array<{ id: string; displayName: string }>>((resolve, reject) => {
      const metadata = this.buildMetadata(session);
      this.client!.ListProjects({}, metadata, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        const projects = (response?.items ?? []).map((item) => ({
          id: item?.id ?? '',
          displayName: item?.display_name ?? item?.id ?? '',
        })).filter((p) => p.id);
        resolve(projects);
      });
    });
  }

  async listWorkspaces(projectIdOverride?: string): Promise<WorkspaceSummary[]> {
    this.ensureSettingsPresent();
    await this.ensureClients();
    if (!this.client) {
      return [];
    }
    const session = await requireSession(true);
    if (!session) {
      throw new Error('Aegis sign-in required.');
    }
    const projectId = projectIdOverride || this.settings?.platform.projectId?.trim();
    if (!projectId) {
      // No project configured — list from all projects via listProjects + per-project listing
      const projects = await this.listProjects();
      if (projects.length === 0) {
        return [];
      }
      const allWorkspaces: WorkspaceSummary[] = [];
      for (const project of projects) {
        const ws = await this.listWorkspaces(project.id);
        allWorkspaces.push(...ws);
      }
      return allWorkspaces;
    }

    const fetchWorkspaces = async (activeSession: vscode.AuthenticationSession) =>
      new Promise<WorkspaceSummary[]>((resolve, reject) => {
        const metadata = this.buildMetadata(activeSession);
        this.client!.ListWorkloads({ project_id: projectId }, metadata, (err, response) => {
          if (err) {
            if ((err as grpc.ServiceError)?.code === grpc.status.NOT_FOUND) {
              out.appendLine(`[platform] project ${projectId} not found; treating as empty workspace list`);
              resolve([]);
              return;
            }
            reject(err);
            return;
          }
          const workspaces = (response?.items ?? []).map((item: any) => {
            const ws = item?.workspace;
            return {
              id: item?.id ?? '',
              name: item?.id ?? 'workspace',
              cluster: item?.cluster_id,
              dns: ws?.env?.DNS,
              profile: ws?.profile ?? undefined,
              persona: ws?.persona ?? undefined,
              status: item?.status ?? undefined,
              uiStatus: item?.ui_status ?? undefined,
              workspaceRoot: ws?.env?.WORKSPACE_ROOT || '/home/aegis/work',
            } as WorkspaceSummary;
          }).filter((ws) => ws.id);
          resolve(workspaces);
        });
      });

    try {
      return await fetchWorkspaces(session);
    } catch (err) {
      if (!isUnauthenticatedError(err)) {
        throw err;
      }
      out.appendLine('[platform] ListWorkloads returned UNAUTHENTICATED, clearing cached auth session and retrying once');
      await signOut().catch(() => undefined);
      const refreshed = await requireSession(true);
      if (!refreshed) {
        throw err;
      }
      return fetchWorkspaces(refreshed);
    }
  }

  async issueProxyTicket(wid: string): Promise<ProxyTicket> {
    this.ensureSettingsPresent();
    await this.ensureClients();
    if (!this.client) {
      throw new Error('Platform gRPC client not initialized.');
    }

    // First try to get existing session silently (with retry for race conditions)
    out.appendLine(`[platform] issueProxyTicket(${wid}) - getting session`);
    let session: vscode.AuthenticationSession | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        session = await vscode.authentication.getSession('aegis', ['platform'], {
          createIfNone: false,
          silent: true,
        });
        if (session) {
          out.appendLine(`[platform] found existing session for ${session.account.label}`);
          break;
        }
        if (attempt < 4) {
          out.appendLine(`[platform] no session yet, waiting... (attempt ${attempt + 1}/5)`);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (err) {
        out.appendLine(`[platform] silent session check failed: ${String(err)}`);
      }
    }

    // If still no session, prompt for sign-in
    if (!session) {
      out.appendLine('[platform] no cached session, prompting sign-in');
      session = await requireSession(true);
    }
    if (!session) {
      throw new Error('Aegis sign-in required.');
    }

    const metadata = this.buildMetadata(session);
    out.appendLine(`[platform] making CreateConnectionSession gRPC call for ${wid}`);

    // Add a deadline to prevent hanging forever
    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 30);

    // Force channel to connect and log state changes
    const channel = (this.client as any).getChannel?.();
    if (channel) {
      const currentState = channel.getConnectivityState(true); // true = try to connect
      out.appendLine(`[platform] gRPC channel state after connect request: ${currentState}`);

      // Watch for state changes
      const watchState = (prevState: number) => {
        channel.watchConnectivityState(prevState, Date.now() + 10000, (err: Error | null) => {
          if (err) {
            out.appendLine(`[platform] gRPC channel watch error: ${err.message}`);
            return;
          }
          const newState = channel.getConnectivityState(false);
          out.appendLine(`[platform] gRPC channel state changed: ${prevState} -> ${newState}`);
          if (newState !== 2 && newState !== 4) { // Not READY or SHUTDOWN
            watchState(newState);
          }
        });
      };
      watchState(currentState);
    }

    const createSession = async (activeSession: vscode.AuthenticationSession) =>
      new Promise<ProxyTicket>((resolve, reject) => {
        const activeMetadata = this.buildMetadata(activeSession);
        this.client!.CreateConnectionSession(
          { workload_id: wid, client: 'vscode' },
          activeMetadata,
          { deadline },
          (err, response) => {
            out.appendLine(`[platform] CreateConnectionSession callback received`);
            if (err) {
              out.appendLine(`[platform] CreateConnectionSession error: ${err.message} (code: ${err.code})`);
              if (err.details) {
                out.appendLine(`[platform] CreateConnectionSession details: ${err.details}`);
              }
              reject(err);
              return;
            }
            if (!response?.proxy_url || !response.token) {
              reject(new Error('Platform returned an incomplete proxy ticket.'));
              return;
            }
            if (response.session_id) {
              currentSessionId = response.session_id;
              out.appendLine(`[platform] stored session_id=${response.session_id}`);
            }
            const ticket: ProxyTicket = {
              proxyUrl: response.proxy_url,
              jwt: response.token,
              ttlSeconds: 0,
              caPem: response.proxy_ca_pem || undefined,
              certPem: undefined,
              keyPem: undefined,
              serverName: undefined,
              jti: response.jti,
              dest: undefined,
              dns: undefined,
              groups: undefined,
              workspaceRoot: response.workspace_root || undefined,
            };
            const expiresAt = response.expires_at_utc ? response.expires_at_utc : undefined;
            lastTicketSummary = {
              proxyUrl: ticket.proxyUrl,
              expiresAt,
              hasClientCert: false,
              jti: ticket.jti,
              dest: ticket.dest,
              serverName: ticket.serverName,
            };
            resolve(ticket);
          },
        );
      });

    try {
      return await createSession(session);
    } catch (err) {
      if (!isUnauthenticatedError(err)) {
        throw err;
      }
      out.appendLine('[platform] CreateConnectionSession returned UNAUTHENTICATED, clearing cached auth session and retrying once');
      await signOut().catch(() => undefined);
      const refreshed = await requireSession(true);
      if (!refreshed) {
        throw err;
      }
      return createSession(refreshed);
    }
  }

  async renewConnectionSession(sessionId: string): Promise<RenewedTicket> {
    this.ensureSettingsPresent();
    await this.ensureClients();
    if (!this.client) {
      throw new Error('Platform gRPC client not initialized.');
    }

    const session = await requireSession(true);
    if (!session) {
      throw new Error('Aegis sign-in required.');
    }

    const metadata = this.buildMetadata(session);
    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 30);

    out.appendLine(`[platform] RenewConnectionSession(${sessionId})`);

    return new Promise<RenewedTicket>((resolve, reject) => {
      this.client!.RenewConnectionSession({ session_id: sessionId }, metadata, { deadline }, (err, response) => {
        if (err) {
          out.appendLine(`[platform] RenewConnectionSession error: ${err.message} (code: ${err.code})`);
          reject(err);
          return;
        }
        if (!response?.token || !response?.proxy_url) {
          reject(new Error('RenewConnectionSession returned incomplete response.'));
          return;
        }

        const renewedSessionId = response.session_id ?? sessionId;
        currentSessionId = renewedSessionId;

        // Compute TTL from expires_at_utc
        let ttlSeconds = 0;
        if (response.expires_at_utc) {
          const expiresMs = new Date(response.expires_at_utc).getTime();
          ttlSeconds = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
        }

        const ticket: RenewedTicket = {
          sessionId: renewedSessionId,
          jwt: response.token,
          proxyUrl: response.proxy_url,
          expiresAtUtc: response.expires_at_utc,
          ttlSeconds,
        };

        lastTicketSummary = {
          proxyUrl: ticket.proxyUrl,
          expiresAt: response.expires_at_utc,
          hasClientCert: false,
          jti: response.jti,
          dest: undefined,
          serverName: undefined,
        };

        out.appendLine(`[platform] RenewConnectionSession success, new ttl=${ttlSeconds}s`);
        resolve(ticket);
      });
    });
  }

  async revokeConnectionSession(sessionId: string): Promise<void> {
    try {
      await this.ensureClients();
    } catch (err) {
      out.appendLine(`[platform] RevokeConnectionSession skipped (client init failed): ${String(err)}`);
      return;
    }
    if (!this.client) {
      out.appendLine('[platform] RevokeConnectionSession skipped (no client)');
      return;
    }

    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('aegis', ['platform'], {
        createIfNone: false,
        silent: true,
      });
    } catch {
      // best-effort: if we can't get a session, skip revocation
    }
    if (!session) {
      out.appendLine('[platform] RevokeConnectionSession skipped (no auth session)');
      return;
    }

    const metadata = this.buildMetadata(session);
    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 10);

    out.appendLine(`[platform] RevokeConnectionSession(${sessionId})`);

    return new Promise<void>((resolve) => {
      this.client!.RevokeConnectionSession({ session_id: sessionId }, metadata, { deadline }, (err) => {
        if (err) {
          out.appendLine(`[platform] RevokeConnectionSession error (ignored): ${err.message}`);
        } else {
          out.appendLine(`[platform] RevokeConnectionSession success`);
        }
        // Always clear the stored session id on revocation attempt
        if (currentSessionId === sessionId) {
          currentSessionId = undefined;
        }
        resolve();
      });
    });
  }

  private buildMetadata(session: vscode.AuthenticationSession): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.add('authorization', `Bearer ${session.accessToken}`);
    if (this.settings?.platform.namespace) {
      metadata.add('x-aegis-namespace', this.settings.platform.namespace);
    }
    return metadata;
  }
}

let clientInstance: PlatformClient | undefined;

export function getPlatformClient(): PlatformClient {
  if (!clientInstance) {
    throw new Error('Platform client not initialized yet.');
  }
  return clientInstance;
}

export async function initializePlatform(context: vscode.ExtensionContext) {
  if (!clientInstance) {
    clientInstance = new PlatformClient(context);
  }
  await clientInstance.initialize();
}

export async function refreshPlatformSettings() {
  if (clientInstance) {
    await clientInstance.refreshSettings();
  }
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return withRetry(
    () => getPlatformClient().listWorkspaces(),
    { maxRetries: 3, baseDelayMs: 1000, label: 'listWorkspaces' },
  );
}

export async function issueProxyTicket(wid: string): Promise<ProxyTicket> {
  return withRetry(
    () => getPlatformClient().issueProxyTicket(wid),
    { maxRetries: 3, baseDelayMs: 1000, label: 'issueProxyTicket' },
  );
}

export async function renewConnectionSession(sessionId: string): Promise<RenewedTicket> {
  return getPlatformClient().renewConnectionSession(sessionId);
}

export async function revokeConnectionSession(sessionId: string): Promise<void> {
  return getPlatformClient().revokeConnectionSession(sessionId);
}
