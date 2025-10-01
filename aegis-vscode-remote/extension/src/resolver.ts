/// <reference path="../vscode.proposed.resolvers.d.ts" />
/// <reference path="../vscode.proposed.tunnels.d.ts" />

import * as vscode from 'vscode';
import { out, status } from './ui';
import { getSettings } from './config';
import { ConnectionManager } from './connection';

let lastConnection: ConnectionManager | undefined;
let lastEnd: (() => void) | undefined;

export function getLastConnection(): ConnectionManager | undefined {
  return lastConnection;
}

export function forceReconnect() {
  if (lastEnd) {
    try {
      lastEnd();
    } finally {
      lastEnd = undefined;
    }
  }
}

export const AegisResolver: vscode.RemoteAuthorityResolver = {
  async resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolverResult> {
    const settings = getSettings();
    const wid = (authority.split('+')[1] || '').trim() || settings.defaultWorkspaceId;
    const url = `${settings.proxyUrl}?wid=${encodeURIComponent(wid)}`;

    out.appendLine(`[resolver] resolve(${authority}) attempt=${context.resolveAttempt} url=${url}`);
    status.set('$(sync~spin) Aegis: Connecting…', url);

    const connection = new ConnectionManager(url, {
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      idleTimeoutMs: settings.idleTimeoutMs,
      tlsInsecure: settings.tlsInsecure,
      logLevel: settings.logLevel,
      log: (message) => out.appendLine(message),
    });
    lastConnection = connection;

    const managed = new vscode.ManagedResolvedAuthority(async () => {
      try {
        const transport = await connection.open();
        status.set('$(plug) Aegis: Connected', url);
        transport.onDidClose(() => status.set('$(debug-disconnect) Aegis: Disconnected', url));
        transport.onDidEnd(() => status.set('$(debug-disconnect) Aegis: Disconnected', url));
        lastEnd = () => transport.end();
        transport.onDidEnd(() => {
          if (lastEnd === transport.end) {
            lastEnd = undefined;
          }
        });
        return transport;
      } catch (err) {
        status.set('$(warning) Aegis: Connection failed', String(err));
        throw err;
      }
    }, 'hello');

    return {
      ...managed,
      extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' },
    };
  }
};
