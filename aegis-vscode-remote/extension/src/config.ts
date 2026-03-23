import * as vscode from 'vscode';
import { isSecureMode, clampLogLevel } from './secure-mode';

export type LogLevel = 'info' | 'debug' | 'trace';

export interface SecuritySettings {
  rejectUnauthorized: boolean;
  mtlsSource: 'platform' | 'system';
  caPath?: string;
}

export interface PlatformSettings {
  url: string; // Single platform URL for auto-discovery (e.g., "aegis.company.mil")
  grpcEndpoint: string;
  grpcServerName: string;
  namespace: string;
  authScope: string;
  projectId: string;
}

export interface AuthSettings {
  authority: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  prompt?: string;
}

export interface AegisSettings {
  platform: PlatformSettings;
  auth: AuthSettings;
  defaultWorkspaceId?: string;
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  security: SecuritySettings;
  logLevel: LogLevel;
  isSecureMode: boolean;
}

// Discovery overrides — set programmatically, merged into getSettings() results.
// These take precedence over VS Code config values when set.
let discoveryOverrides: Partial<{
  grpcEndpoint: string;
  authAuthority: string;
  authClientId: string;
  caPath: string;
}> = {};

export function setDiscoveryOverrides(overrides: typeof discoveryOverrides) {
  discoveryOverrides = { ...discoveryOverrides, ...overrides };
}

export function getSettings(): AegisSettings {
  const cfg = vscode.workspace.getConfiguration('aegisRemote');
  const secure = isSecureMode();

  let scopes: string[] = cfg.get('auth.scopes', ['openid', 'profile', 'email', 'offline_access']);
  if (secure) {
    scopes = scopes.filter((s) => s !== 'offline_access');
  }

  return {
    platform: {
      url: cfg.get('platform.url', ''),
      grpcEndpoint: discoveryOverrides.grpcEndpoint || cfg.get('platform.grpcEndpoint', ''),
      grpcServerName: cfg.get('platform.grpcServerName', ''),
      namespace: cfg.get('platform.namespace', 'default'),
      authScope: cfg.get('platform.authScope', 'aegis-platform'),
      projectId: cfg.get('platform.projectId', ''),
    },
    auth: {
      authority: discoveryOverrides.authAuthority || cfg.get('auth.authority', ''),
      clientId: discoveryOverrides.authClientId || cfg.get('auth.clientId', ''),
      redirectUri: cfg.get('auth.redirectUri', 'vscode://aegis.aegis-remote/auth'),
      scopes,
      prompt: cfg.get('auth.prompt', ''),
    },
    defaultWorkspaceId: cfg.get('defaultWorkspaceId', ''),
    heartbeatIntervalMs: cfg.get('heartbeatIntervalMs', 15_000),
    idleTimeoutMs: cfg.get('idleTimeoutMs', 45_000),
    security: {
      rejectUnauthorized: secure ? true : cfg.get('security.rejectUnauthorized', true),
      mtlsSource: cfg.get('security.mtlsSource', 'platform'),
      caPath: discoveryOverrides.caPath || cfg.get('security.caPath', ''),
    },
    logLevel: clampLogLevel(cfg.get('logLevel', 'info')),
    isSecureMode: secure,
  };
}

export function onDidChangeSettings(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('aegisRemote')) {
      listener();
    }
  });
}
