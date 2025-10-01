"use strict";
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
exports.getSettings = getSettings;
exports.onDidChangeSettings = onDidChangeSettings;
const vscode = __importStar(require("vscode"));
function getSettings() {
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
function onDidChangeSettings(listener) {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aegisRemote')) {
            listener();
        }
    });
}
