import * as vscode from 'vscode';

export type LogLevel = 'info' | 'debug' | 'trace';

export interface AegisSettings {
  proxyUrl: string;
  defaultWorkspaceId: string;
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  tlsInsecure: boolean;
  logLevel: LogLevel;
}

export function getSettings(): AegisSettings {
  const cfg = vscode.workspace.getConfiguration('aegisRemote');
  return {
    proxyUrl: cfg.get('proxyUrl', 'wss://127.0.0.1:7001/tunnel'),
    defaultWorkspaceId: cfg.get('defaultWorkspaceId', 'w-1234'),
    heartbeatIntervalMs: cfg.get('heartbeatIntervalMs', 15_000),
    idleTimeoutMs: cfg.get('idleTimeoutMs', 45_000),
    tlsInsecure: cfg.get('tls.insecure', true),
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
