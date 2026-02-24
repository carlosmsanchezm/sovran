/// <reference path="../vscode.proposed.resolvers.d.ts" />
/// <reference path="../vscode.proposed.tunnels.d.ts" />

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { out, status } from './ui';
import { getSettings } from './config';
import { ConnectionManager } from './connection';
import { issueProxyTicket, renewConnectionSession, revokeConnectionSession, getCurrentSessionId, clearCurrentSessionId } from './platform';
import { categorizeConnectionError } from './errors';

let lastConnection: ConnectionManager | undefined;
let lastEnd: (() => void) | undefined;
let renewalTimer: NodeJS.Timeout | undefined;

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
  // Best-effort revocation of the previous session (fire-and-forget)
  void revokeCurrentSession();
}

export const AegisResolver: vscode.RemoteAuthorityResolver = {
  async resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolverResult> {
    const settings = getSettings();
    const widFromAuthority = (authority.split('+')[1] || '').trim();
    const wid = widFromAuthority || settings.defaultWorkspaceId;
    if (!wid) {
      throw new Error('Workspace id not provided.');
    }

    out.appendLine(`[resolver] resolve(${authority}) attempt=${context.resolveAttempt}`);
    const widLabel = `workspace ${wid}`;
    status.set(`$(sync~spin) Aegis: Connecting ${widLabel}…`);

    if (renewalTimer) {
      clearTimeout(renewalTimer);
      renewalTimer = undefined;
    }

    const managed = new vscode.ManagedResolvedAuthority(async () => {
      try {
        out.appendLine(`[resolver] makeConnection callback starting for ${wid}`);
        // Get a fresh ticket for each connection attempt (tokens are one-time use)
        const ticket = await issueProxyTicket(wid);
        const url = buildWebSocketUrl(ticket.proxyUrl, wid);
        out.appendLine(`[resolver] got ticket for ${wid}, url=${url}`);

        const caBuffers: Buffer[] = [];
        if (ticket.caPem) {
          caBuffers.push(Buffer.from(ticket.caPem));
        }
        if (settings.security.caPath) {
          try {
            const fileCa = await fs.readFile(settings.security.caPath);
            caBuffers.push(fileCa);
          } catch (err) {
            out.appendLine(`[resolver] failed to read CA bundle: ${String(err)}`);
          }
        }

        const tlsOptions = {
          ca: caBuffers.length === 0 ? undefined : caBuffers.length === 1 ? caBuffers[0] : caBuffers,
          cert: ticket.certPem ? Buffer.from(ticket.certPem) : undefined,
          key: ticket.keyPem ? Buffer.from(ticket.keyPem) : undefined,
          servername: ticket.serverName,
        };

        const connection = new ConnectionManager(url, {
          heartbeatIntervalMs: settings.heartbeatIntervalMs,
          idleTimeoutMs: settings.idleTimeoutMs,
          logLevel: settings.logLevel,
          log: (message) => out.appendLine(message),
          headers: { Authorization: `Bearer ${ticket.jwt}` },
          tls: tlsOptions,
          rejectUnauthorized: settings.security.rejectUnauthorized,
        });
        lastConnection = connection;

        const transport = await connection.open();
        status.set(`$(plug) Aegis: Connected ${widLabel}`, url);

        transport.onDidClose((closeErr) => {
          const closeInfo = connection.lastCloseInfo;
          if (closeInfo) {
            // Update status bar with disconnect reason (Task #23)
            status.set(`$(debug-disconnect) Aegis: ${closeInfo.userMessage}`, url);
            if (closeInfo.isAbnormal) {
              // Offer a "Reconnect" action button for abnormal closures
              vscode.window.showWarningMessage(
                closeInfo.userMessage,
                'Reconnect',
                'Show Logs',
              ).then(selection => {
                if (selection === 'Reconnect') {
                  vscode.commands.executeCommand('aegis.reconnect');
                } else if (selection === 'Show Logs') {
                  vscode.commands.executeCommand('aegis.showLogs');
                }
              });
            } else {
              // Normal close (code 1000)
              vscode.window.showInformationMessage(closeInfo.userMessage);
            }
          } else {
            status.set(`$(debug-disconnect) Aegis: Disconnected ${widLabel}`, url);
          }
        });
        transport.onDidEnd(() => {
          const closeInfo = connection.lastCloseInfo;
          if (!closeInfo) {
            status.set(`$(debug-disconnect) Aegis: Disconnected ${widLabel}`, url);
          }
        });
        lastEnd = () => transport.end();
        transport.onDidEnd(() => {
          if (lastEnd === transport.end) {
            lastEnd = undefined;
          }
          if (renewalTimer) {
            clearTimeout(renewalTimer);
            renewalTimer = undefined;
          }
        });
        if (ticket.ttlSeconds > 0) {
          scheduleRenewal(ticket.ttlSeconds, wid);
        }
        return transport;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        out.appendLine(`[resolver] connection failed for ${wid}: ${errMsg}`);
        if (err instanceof Error && err.stack) {
          out.appendLine(`[resolver] stack: ${err.stack}`);
        }

        // Categorize the error for user-facing messaging (Task #21)
        const categorized = categorizeConnectionError(err);
        out.appendLine(`[resolver] error category=${categorized.category}: ${categorized.message}`);
        status.set(`$(warning) Aegis: Connection failed ${widLabel}`, categorized.message);

        // Show categorized error to the user with appropriate actions
        if (categorized.category === 'auth') {
          vscode.window.showErrorMessage(categorized.message, 'Sign Out & Re-authenticate').then(selection => {
            if (selection === 'Sign Out & Re-authenticate') {
              vscode.commands.executeCommand('aegis.signOut').then(() => {
                vscode.commands.executeCommand('aegis.signIn');
              });
            }
          });
        } else if (categorized.category === 'network') {
          vscode.window.showErrorMessage(categorized.message, 'Show Logs', 'Open Settings').then(selection => {
            if (selection === 'Show Logs') {
              vscode.commands.executeCommand('aegis.showLogs');
            } else if (selection === 'Open Settings') {
              vscode.commands.executeCommand('workbench.action.openSettings', 'aegisRemote');
            }
          });
        } else {
          vscode.window.showErrorMessage(categorized.message, 'Show Logs').then(selection => {
            if (selection === 'Show Logs') {
              vscode.commands.executeCommand('aegis.showLogs');
            }
          });
        }

        throw err;
      }
    }, 'hello');

    return {
      ...managed,
      extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' },
    };
  }
};

function scheduleRenewal(ttlSeconds: number, wid: string) {
  if (renewalTimer) {
    clearTimeout(renewalTimer);
    renewalTimer = undefined;
  }
  const renewMs = Math.max(5_000, Math.floor(ttlSeconds * 1000 * 0.85));
  out.appendLine(`[resolver] scheduling session renewal in ${Math.round(renewMs / 1000)}s for workspace ${wid}`);

  renewalTimer = setTimeout(async () => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      out.appendLine('[resolver] no session_id available, falling back to force reconnect');
      forceReconnect();
      return;
    }

    try {
      out.appendLine(`[resolver] renewing session ${sessionId} for workspace ${wid}`);
      const renewed = await renewConnectionSession(sessionId);
      out.appendLine(`[resolver] session renewed, new ttl=${renewed.ttlSeconds}s`);

      // Schedule the next renewal based on the new TTL
      if (renewed.ttlSeconds > 0) {
        scheduleRenewal(renewed.ttlSeconds, wid);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      out.appendLine(`[resolver] session renewal failed (${errMsg}), falling back to force reconnect`);
      forceReconnect();
    }
  }, renewMs);
}

/** Best-effort revocation of the current connection session. */
export async function revokeCurrentSession(): Promise<void> {
  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    return;
  }
  try {
    await revokeConnectionSession(sessionId);
  } catch (err) {
    out.appendLine(`[resolver] revokeCurrentSession error (ignored): ${String(err)}`);
  } finally {
    clearCurrentSessionId();
  }
}

function buildWebSocketUrl(rawProxyUrl: string, wid: string): string {
  if (!rawProxyUrl) {
    throw new Error('Proxy URL missing from ticket.');
  }

  const trimmed = rawProxyUrl.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch (err) {
    throw new Error(`Invalid proxy URL from ticket: ${trimmed}`);
  }

  const encodedWid = encodeURIComponent(wid);
  const suffix = `/proxy/${encodedWid}`;
  const pathSansTrailingSlash = url.pathname.replace(/\/+$/, '');

  const alreadyHasSuffix = pathSansTrailingSlash === suffix
    || pathSansTrailingSlash === `/proxy/${wid}`
    || pathSansTrailingSlash.endsWith(`/proxy/${encodedWid}`)
    || pathSansTrailingSlash.endsWith(`/proxy/${wid}`);

  if (!alreadyHasSuffix) {
    if (pathSansTrailingSlash === '' || pathSansTrailingSlash === '/') {
      url.pathname = suffix;
    } else if (pathSansTrailingSlash === '/proxy') {
      url.pathname = suffix;
    } else if (pathSansTrailingSlash.endsWith('/proxy')) {
      url.pathname = `${pathSansTrailingSlash}/${encodedWid}`;
    } else if (pathSansTrailingSlash.includes('/proxy/')) {
      // Ticket specifies a proxy path already; trust it as-is.
      url.pathname = pathSansTrailingSlash;
    } else {
      const base = pathSansTrailingSlash.startsWith('/') ? pathSansTrailingSlash : `/${pathSansTrailingSlash}`;
      url.pathname = `${base}${suffix}`;
    }
  } else {
    url.pathname = pathSansTrailingSlash || suffix;
  }

  switch (url.protocol) {
    case 'ws:':
    case 'wss:':
      url.protocol = 'wss:';
      break;
    case 'http:':
    case 'https:':
    default:
      url.protocol = 'wss:';
      break;
  }

  return url.toString();
}
