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
const ui_1 = require("./ui");
const config_1 = require("./config");
const connection_1 = require("./connection");
let lastConnection;
let lastEnd;
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
        const wid = (authority.split('+')[1] || '').trim() || settings.defaultWorkspaceId;
        const url = `${settings.proxyUrl}?wid=${encodeURIComponent(wid)}`;
        ui_1.out.appendLine(`[resolver] resolve(${authority}) attempt=${context.resolveAttempt} url=${url}`);
        ui_1.status.set('$(sync~spin) Aegis: Connecting…', url);
        const connection = new connection_1.ConnectionManager(url, {
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            idleTimeoutMs: settings.idleTimeoutMs,
            tlsInsecure: settings.tlsInsecure,
            logLevel: settings.logLevel,
            log: (message) => ui_1.out.appendLine(message),
        });
        lastConnection = connection;
        const managed = new vscode.ManagedResolvedAuthority(async () => {
            try {
                const transport = await connection.open();
                ui_1.status.set('$(plug) Aegis: Connected', url);
                transport.onDidClose(() => ui_1.status.set('$(debug-disconnect) Aegis: Disconnected', url));
                transport.onDidEnd(() => ui_1.status.set('$(debug-disconnect) Aegis: Disconnected', url));
                lastEnd = () => transport.end();
                transport.onDidEnd(() => {
                    if (lastEnd === transport.end) {
                        lastEnd = undefined;
                    }
                });
                return transport;
            }
            catch (err) {
                ui_1.status.set('$(warning) Aegis: Connection failed', String(err));
                throw err;
            }
        }, 'hello');
        return {
            ...managed,
            extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' },
        };
    }
};
