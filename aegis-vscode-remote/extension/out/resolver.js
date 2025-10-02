"use strict";
/// <reference path="../vscode.proposed.resolvers.d.ts" />
/// <reference path="../vscode.proposed.tunnels.d.ts" />
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AegisResolver = void 0;
exports.getLastConnection = getLastConnection;
exports.forceReconnect = forceReconnect;
const vscode = __importStar(require("vscode"));
const fs_1 = require("fs");
const ui_1 = require("./ui");
const config_1 = require("./config");
const connection_1 = require("./connection");
const platform_1 = require("./platform");
let lastConnection;
let lastEnd;
let renewalTimer;
function getLastConnection() {
    return lastConnection;
}
function forceReconnect() {
    if (lastEnd) {
        try {
            lastEnd();
        }
        finally {
            lastEnd = undefined;
        }
    }
}
exports.AegisResolver = {
    async resolve(authority, context) {
        const settings = (0, config_1.getSettings)();
        const widFromAuthority = (authority.split('+')[1] || '').trim();
        const wid = widFromAuthority || settings.defaultWorkspaceId;
        if (!wid) {
            throw new Error('Workspace id not provided.');
        }
        const ticket = await (0, platform_1.issueProxyTicket)(wid);
        const url = buildWebSocketUrl(ticket.proxyUrl, wid);
        ui_1.out.appendLine(`[resolver] resolve(${authority}) attempt=${context.resolveAttempt} url=${url}`);
        const widLabel = `workspace ${wid}`;
        ui_1.status.set(`$(sync~spin) Aegis: Connecting ${widLabel}…`, url);
        const caBuffers = [];
        if (ticket.caPem) {
            caBuffers.push(Buffer.from(ticket.caPem));
        }
        if (settings.security.caPath) {
            try {
                const fileCa = await fs_1.promises.readFile(settings.security.caPath);
                caBuffers.push(fileCa);
            }
            catch (err) {
                ui_1.out.appendLine(`[resolver] failed to read CA bundle: ${String(err)}`);
            }
        }
        const tlsOptions = {
            ca: caBuffers.length === 0 ? undefined : caBuffers.length === 1 ? caBuffers[0] : caBuffers,
            cert: ticket.certPem ? Buffer.from(ticket.certPem) : undefined,
            key: ticket.keyPem ? Buffer.from(ticket.keyPem) : undefined,
            servername: ticket.serverName,
        };
        if (renewalTimer) {
            clearTimeout(renewalTimer);
            renewalTimer = undefined;
        }
        const connection = new connection_1.ConnectionManager(url, {
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            idleTimeoutMs: settings.idleTimeoutMs,
            logLevel: settings.logLevel,
            log: (message) => ui_1.out.appendLine(message),
            headers: { Authorization: `Bearer ${ticket.jwt}` },
            tls: tlsOptions,
            rejectUnauthorized: settings.security.rejectUnauthorized,
        });
        lastConnection = connection;
        const managed = new vscode.ManagedResolvedAuthority(async () => {
            try {
                const transport = await connection.open();
                ui_1.status.set(`$(plug) Aegis: Connected ${widLabel}`, url);
                transport.onDidClose(() => ui_1.status.set(`$(debug-disconnect) Aegis: Disconnected ${widLabel}`, url));
                transport.onDidEnd(() => ui_1.status.set(`$(debug-disconnect) Aegis: Disconnected ${widLabel}`, url));
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
                        ui_1.out.appendLine(`[resolver] renewing ticket for workspace ${wid}`);
                        forceReconnect();
                    }, renewMs);
                }
                return transport;
            }
            catch (err) {
                ui_1.status.set(`$(warning) Aegis: Connection failed ${widLabel}`, String(err));
                throw err;
            }
        }, 'hello');
        return {
            ...managed,
            extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' },
        };
    }
};
function buildWebSocketUrl(rawProxyUrl, wid) {
    if (!rawProxyUrl) {
        throw new Error('Proxy URL missing from ticket.');
    }
    const trimmed = rawProxyUrl.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const candidate = hasScheme ? trimmed : `https://${trimmed}`;
    let url;
    try {
        url = new URL(candidate);
    }
    catch (err) {
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
        }
        else if (pathSansTrailingSlash === '/proxy') {
            url.pathname = suffix;
        }
        else if (pathSansTrailingSlash.endsWith('/proxy')) {
            url.pathname = `${pathSansTrailingSlash}/${encodedWid}`;
        }
        else if (pathSansTrailingSlash.includes('/proxy/')) {
            // Ticket specifies a proxy path already; trust it as-is.
            url.pathname = pathSansTrailingSlash;
        }
        else {
            const base = pathSansTrailingSlash.startsWith('/') ? pathSansTrailingSlash : `/${pathSansTrailingSlash}`;
            url.pathname = `${base}${suffix}`;
        }
    }
    else {
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
