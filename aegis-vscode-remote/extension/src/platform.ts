import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as vscode from 'vscode';
import * as path from 'path';
import { getSettings, AegisSettings } from './config';
import { getSessionUser, requireSession } from './auth';
import { out } from './ui';
import { loadCombinedCAsBuffer } from './tls';

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
}

export interface ProxyTicketSummary {
  proxyUrl: string;
  expiresAt?: string;
  hasClientCert: boolean;
  jti?: string;
  dest?: string;
  serverName?: string;
}

let lastTicketSummary: ProxyTicketSummary | undefined;

export function getLastProxyTicketSummary(): ProxyTicketSummary | undefined {
  return lastTicketSummary;
}

type PlatformClientGrpc = grpc.Client & {
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
      response: {
        session_id?: string;
        token?: string;
        proxy_url?: string;
        ssh_user?: string;
        ssh_host_alias?: string;
        expires_at_utc?: string;
        ssh_config?: string;
        one_time?: boolean;
        jti?: string;
      }
    ) => void
  ): grpc.ClientUnaryCall;
};

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
    this.settings = settings;

    const endpoint = this.normalizeEndpoint(settings.platform.grpcEndpoint);
    if (!endpoint) {
      this.disposeClients();
      return;
    }

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
    const clientOptions: grpc.ClientOptions = {
      'grpc.max_receive_message_length': 10 * 1024 * 1024,
      'grpc.ssl_target_name_override': endpoint.split(':')[0], // Use hostname for TLS verification
      'grpc.default_authority': endpoint.split(':')[0],
    };
    out.appendLine(`[platform] gRPC client options: ssl_target_name_override=${endpoint.split(':')[0]}`);

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
      out.appendLine('[platform] creating insecure gRPC client for local development');
      return grpc.credentials.createInsecure();
    }

    if (security.rejectUnauthorized === false) {
      out.appendLine('[platform] creating insecure gRPC client (TLS verification disabled by settings)');
      return grpc.credentials.createInsecure();
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

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    this.ensureSettingsPresent();
    await this.ensureClients();
    if (!this.client) {
      return [];
    }
    const session = await requireSession(true);
    if (!session) {
      throw new Error('Aegis sign-in required.');
    }
    const projectId = this.settings?.platform.projectId?.trim();
    if (!projectId) {
      throw new Error('Configure "aegisRemote.platform.projectId" in settings.');
    }

    const metadata = this.buildMetadata(session);
    return new Promise<WorkspaceSummary[]>((resolve, reject) => {
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
          } as WorkspaceSummary;
        }).filter((ws) => ws.id);
        resolve(workspaces);
      });
    });
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

    return new Promise<ProxyTicket>((resolve, reject) => {
      const call = this.client!.CreateConnectionSession({ workload_id: wid, client: 'vscode' }, metadata, { deadline }, (err, response) => {
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
        const ticket: ProxyTicket = {
          proxyUrl: response.proxy_url,
          jwt: response.token,
          ttlSeconds: 0,
          caPem: undefined,
          certPem: undefined,
          keyPem: undefined,
          serverName: undefined,
          jti: response.jti,
          dest: undefined,
          dns: undefined,
          groups: undefined,
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
  return getPlatformClient().listWorkspaces();
}

export async function issueProxyTicket(wid: string): Promise<ProxyTicket> {
  return getPlatformClient().issueProxyTicket(wid);
}
