import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { getSettings, AegisSettings } from './config';
import { requireSession } from './auth';
import { out } from './ui';

interface WorkspaceMessage {
  id: string;
  name: string;
  cluster?: string;
  dns?: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  cluster?: string;
  dns?: string;
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
  ): void;
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
    };

    const serviceDef = namespace.AegisPlatform ?? namespace.AegisPlatformService ?? namespace.PlatformService;
    if (typeof serviceDef !== 'function') {
      throw new Error('AegisPlatform service constructor not found in loaded proto definition');
    }
    this.client = new serviceDef(endpoint, tlsCreds, clientOptions) as PlatformClientGrpc;
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

    let ca: Buffer | undefined;
    if (security.caPath) {
      try {
        ca = await fs.readFile(security.caPath);
      } catch (err) {
        out.appendLine(`[platform] failed to read CA bundle at ${security.caPath}: ${String(err)}`);
      }
    }
    out.appendLine('[platform] creating secure gRPC client');
    if (ca) {
      out.appendLine(`[platform] loaded CA bundle (${security.caPath}) length=${ca.length}`);
    } else if (security.caPath) {
      out.appendLine(`[platform] WARNING: no CA loaded from ${security.caPath}`);
    }
    return grpc.credentials.createSsl(ca);
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
    const session = await requireSession(true);
    if (!session) {
      throw new Error('Aegis sign-in required.');
    }

    const metadata = this.buildMetadata(session);
    return new Promise<ProxyTicket>((resolve, reject) => {
      this.client!.CreateConnectionSession({ workload_id: wid, client: 'vscode' }, metadata, (err, response) => {
        if (err) {
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
    const subject = session.account?.label || session.account?.id;
    if (subject) {
      metadata.add('x-aegis-user', subject);
    }
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
