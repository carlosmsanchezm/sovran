/// <reference path="../vscode.proposed.resolvers.d.ts" />
/// <reference path="../vscode.proposed.tunnels.d.ts" />

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { out, status } from './ui';
import { getSettings } from './config';
import { ConnectionManager } from './connection';
import { issueProxyTicket } from './platform';

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
        transport.onDidClose(() => status.set(`$(debug-disconnect) Aegis: Disconnected ${widLabel}`, url));
        transport.onDidEnd(() => status.set(`$(debug-disconnect) Aegis: Disconnected ${widLabel}`, url));
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
          const renewMs = Math.max(5_000, Math.floor(ticket.ttlSeconds * 1000 * 0.85));
          renewalTimer = setTimeout(() => {
            out.appendLine(`[resolver] renewing ticket for workspace ${wid}`);
            forceReconnect();
          }, renewMs);
        }
        return transport;
      } catch (err) {
        status.set(`$(warning) Aegis: Connection failed ${widLabel}`, String(err));
        throw err;
      }
    }, 'hello');

    return {
      ...managed,
      extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' },
    };
  }
};

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
