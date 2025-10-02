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
exports.WorkspacesProvider = exports.status = exports.Status = exports.out = void 0;
const vscode = __importStar(require("vscode"));
const platform_1 = require("./platform");
exports.out = vscode.window.createOutputChannel('Aegis Remote');
class Status {
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    set(text, tooltip) { this.item.text = text; this.item.tooltip = tooltip; this.item.show(); }
}
exports.Status = Status;
exports.status = new Status();
class WorkspaceTreeItem extends vscode.TreeItem {
    workspace;
    constructor(workspace) {
        super(workspace.name ?? workspace.id, vscode.TreeItemCollapsibleState.None);
        this.workspace = workspace;
        this.contextValue = 'workspace';
        const descriptionParts = [];
        if (workspace.cluster)
            descriptionParts.push(workspace.cluster);
        if (workspace.dns)
            descriptionParts.push(workspace.dns);
        this.description = descriptionParts.join(' · ') || undefined;
        this.command = {
            command: 'aegis.connect',
            title: 'Connect',
            arguments: [workspace.id],
        };
    }
}
class WorkspacesProvider {
    context;
    onDidChangeEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.onDidChangeEmitter.event;
    loading = false;
    loadedOnce = false;
    lastError;
    items = [];
    constructor(context) {
        this.context = context;
    }
    dispose() {
        this.onDidChangeEmitter.dispose();
    }
    refresh() {
        this.loadedOnce = false;
        this.onDidChangeEmitter.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren() {
        if (this.loading) {
            return [this.createInfoItem('Loading workspaces…')];
        }
        if (!this.loadedOnce) {
            await this.load();
        }
        if (this.items.length > 0) {
            return this.items;
        }
        if (this.lastError) {
            return [this.createErrorItem(this.lastError)];
        }
        return [this.createInfoItem('No workspaces available')];
    }
    async load() {
        this.loading = true;
        this.onDidChangeEmitter.fire();
        try {
            const workspaces = await (0, platform_1.listWorkspaces)();
            this.items = workspaces.map((ws) => new WorkspaceTreeItem(ws));
            this.lastError = undefined;
        }
        catch (err) {
            this.lastError = err;
            this.items = [];
            exports.out.appendLine(`[ui] failed to load workspaces: ${String(err)}`);
        }
        finally {
            this.loading = false;
            this.loadedOnce = true;
            this.onDidChangeEmitter.fire();
        }
    }
    createInfoItem(text) {
        const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'info';
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
    }
    createErrorItem(error) {
        const message = this.describeError(error);
        if (message === 'Aegis sign-in required.') {
            const item = new vscode.TreeItem('Sign in to Aegis…', vscode.TreeItemCollapsibleState.None);
            item.contextValue = 'auth';
            item.iconPath = new vscode.ThemeIcon('key');
            item.command = { command: 'aegis.signIn', title: 'Sign In' };
            return item;
        }
        if (/Configure/.test(message)) {
            const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
            item.contextValue = 'settings';
            item.iconPath = new vscode.ThemeIcon('gear');
            item.command = {
                command: 'workbench.action.openSettings',
                title: 'Open Settings',
                arguments: ['aegisRemote.platform.grpcEndpoint'],
            };
            return item;
        }
        const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'error';
        item.iconPath = new vscode.ThemeIcon('error');
        return item;
    }
    describeError(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return typeof error === 'string' ? error : 'Unable to load workspaces';
    }
}
exports.WorkspacesProvider = WorkspacesProvider;
