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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AegisResolver = void 0;
const vscode = __importStar(require("vscode"));
const ui_1 = require("./ui");
const ws_1 = __importDefault(require("ws"));
function makeManagedConnection(url) {
    const onDidReceiveMessage = new vscode.EventEmitter();
    const onDidClose = new vscode.EventEmitter();
    const onDidEnd = new vscode.EventEmitter();
    return new Promise((resolve, reject) => {
        const ws = new ws_1.default(url, { perMessageDeflate: false, rejectUnauthorized: false }); // self-signed OK for dev
        ws.binaryType = 'arraybuffer';
        ws.on('open', () => {
            ui_1.status.set('$(plug) Aegis: Connected');
            ui_1.out.appendLine(`[client] ws open ${url}`);
            resolve({
                onDidReceiveMessage: onDidReceiveMessage.event,
                onDidClose: onDidClose.event,
                onDidEnd: onDidEnd.event,
                send: (data) => { ws.send(data); },
                end: () => { ws.close(); }
            });
        });
        ws.on('message', (data) => {
            const buf = data instanceof Buffer ? data : Buffer.from(data);
            onDidReceiveMessage.fire(buf);
        });
        ws.on('close', (code, reason) => {
            ui_1.out.appendLine(`[client] ws close ${code} ${reason}`);
            ui_1.status.set('$(debug-disconnect) Aegis: Disconnected');
            onDidClose.fire(undefined);
            onDidEnd.fire();
        });
        ws.on('error', (err) => {
            ui_1.out.appendLine(`[client] ws error: ${String(err)}`);
            ui_1.status.set('$(error) Aegis: Error');
            // On error before 'open', reject so VS Code can retry
            reject(err);
        });
    });
}
exports.AegisResolver = {
    async resolve(authority, context) {
        // authority is like: "aegis+w-1234"
        const wid = (authority.split('+')[1] || '').trim() || 'w-1234';
        const wssUrl = `wss://127.0.0.1:7001/tunnel?wid=${encodeURIComponent(wid)}`;
        ui_1.out.appendLine(`[resolver] resolve(${authority}) attempt=${context.resolveAttempt} url=${wssUrl}`);
        ui_1.status.set('$(sync~spin) Aegis: Connecting…', wssUrl);
        const managed = new vscode.ManagedResolvedAuthority(async () => makeManagedConnection(wssUrl));
        // Optional: pass environment for extension host if needed
        return {
            ...managed,
            extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' }
        };
    }
};
