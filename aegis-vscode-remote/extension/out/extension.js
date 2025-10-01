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
exports.activate = activate;
exports.deactivate = deactivate;
/// <reference path="../vscode.proposed.resolvers.d.ts" />
const vscode = __importStar(require("vscode"));
const ui_1 = require("./ui");
const resolver_1 = require("./resolver");
const diagnostics_1 = require("./diagnostics");
const config_1 = require("./config");
function activate(ctx) {
    ui_1.out.appendLine('Aegis Remote activated');
    ui_1.status.set('$(circle-outline) Aegis: Idle');
    // Register resolver for "aegis" authority
    ctx.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver('aegis', resolver_1.AegisResolver));
    (0, diagnostics_1.registerDiagnostics)(ctx, resolver_1.getLastConnection);
    ctx.subscriptions.push((0, config_1.onDidChangeSettings)(() => {
        const cfg = (0, config_1.getSettings)();
        ui_1.out.appendLine('[settings] updated ' + JSON.stringify(cfg));
    }));
    // TreeView
    const provider = new ui_1.WorkspacesProvider();
    ctx.subscriptions.push(vscode.window.createTreeView('aegis.workspaces', { treeDataProvider: provider }));
    // Commands
    ctx.subscriptions.push(vscode.commands.registerCommand('aegis.showLogs', () => ui_1.out.show()), vscode.commands.registerCommand('aegis.disconnect', () => vscode.commands.executeCommand('workbench.action.closeWindow')), vscode.commands.registerCommand('aegis.reconnect', () => {
        (0, resolver_1.forceReconnect)();
    }), vscode.commands.registerCommand('aegis.connect', async (wid) => {
        const selected = wid || 'w-1234';
        const uri = vscode.Uri.parse(`vscode-remote://aegis+${selected}/home/project`);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    }));
}
function deactivate() { }
