import * as vscode from 'vscode';

export type LogLevel = 'info' | 'debug' | 'trace';

export interface SecuritySettings {
  rejectUnauthorized: boolean;
  mtlsSource: 'platform' | 'system';
  caPath?: string;
}

export interface PlatformSettings {
  grpcEndpoint: string;
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
}

export function getSettings(): AegisSettings {
  const cfg = vscode.workspace.getConfiguration('aegisRemote');
  return {
    platform: {
      grpcEndpoint: cfg.get('platform.grpcEndpoint', ''),
      namespace: cfg.get('platform.namespace', 'default'),
      authScope: cfg.get('platform.authScope', 'aegis-platform'),
      projectId: cfg.get('platform.projectId', ''),
    },
    auth: {
      authority: cfg.get('auth.authority', ''),
      clientId: cfg.get('auth.clientId', ''),
      redirectUri: cfg.get('auth.redirectUri', 'vscode://aegis.aegis-remote/auth'),
      scopes: cfg.get('auth.scopes', ['openid', 'profile', 'email', 'offline_access']),
      prompt: cfg.get('auth.prompt', ''),
    },
    defaultWorkspaceId: cfg.get('defaultWorkspaceId', ''),
    heartbeatIntervalMs: cfg.get('heartbeatIntervalMs', 15_000),
    idleTimeoutMs: cfg.get('idleTimeoutMs', 45_000),
    security: {
      rejectUnauthorized: cfg.get('security.rejectUnauthorized', true),
      mtlsSource: cfg.get('security.mtlsSource', 'platform'),
      caPath: cfg.get('security.caPath', ''),
    },
    logLevel: cfg.get('logLevel', 'info'),
  };
}

export function onDidChangeSettings(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('aegisRemote')) {
      listener();
    }
  });
}
