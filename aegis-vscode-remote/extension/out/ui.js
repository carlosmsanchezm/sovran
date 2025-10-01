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
exports.out = vscode.window.createOutputChannel('Aegis Remote');
class Status {
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    set(text, tooltip) { this.item.text = text; this.item.tooltip = tooltip; this.item.show(); }
}
exports.Status = Status;
exports.status = new Status();
class WorkspacesProvider {
    onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this.onDidChange.event;
    refresh() { this.onDidChange.fire(); }
    getTreeItem(e) { return e; }
    getChildren() {
        return [
            new vscode.TreeItem('w-1234', vscode.TreeItemCollapsibleState.None)
        ].map(i => { i.contextValue = 'workspace'; i.command = { command: 'aegis.connect', title: 'Connect', arguments: ['w-1234'] }; return i; });
    }
}
exports.WorkspacesProvider = WorkspacesProvider;
