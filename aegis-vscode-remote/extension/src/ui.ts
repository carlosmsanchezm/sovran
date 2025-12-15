import * as vscode from 'vscode';
import { listWorkspaces, WorkspaceSummary } from './platform';

export const out = vscode.window.createOutputChannel('Aegis Remote');

export class Status {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  set(text: string, tooltip?: string) { this.item.text = text; this.item.tooltip = tooltip; this.item.show(); }
}
export const status = new Status();

class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(public readonly workspace: WorkspaceSummary) {
    super(workspace.name ?? workspace.id, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'workspace';
    const descriptionParts: string[] = [];
    if (workspace.cluster) descriptionParts.push(workspace.cluster);
    if (workspace.dns) descriptionParts.push(workspace.dns);
    if (workspace.profile) descriptionParts.push(`profile: ${workspace.profile}`);
    this.description = descriptionParts.join(' · ') || undefined;
    this.command = {
      command: 'aegis.connect',
      title: 'Connect',
      arguments: [workspace.id],
    };
  }
}

export class WorkspacesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  private loading = false;
  private loadedOnce = false;
  private lastError: unknown;
  private items: vscode.TreeItem[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose() {
    this.onDidChangeEmitter.dispose();
  }

  refresh() {
    out.appendLine('[ui] refresh() called');
    this.loadedOnce = false;
    this.onDidChangeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    out.appendLine(`[ui] getChildren() called, loading=${this.loading}, loadedOnce=${this.loadedOnce}`);
    if (this.loading) {
      return [this.createInfoItem('Loading workspaces…')];
    }
    if (!this.loadedOnce) {
      await this.load();
    }
    if (this.items.length > 0) {
      out.appendLine(`[ui] returning ${this.items.length} workspaces`);
      return this.items;
    }
    if (this.lastError) {
      out.appendLine(`[ui] returning error: ${String(this.lastError)}`);
      return [this.createErrorItem(this.lastError)];
    }
    return [this.createInfoItem('No workspaces available')];
  }

  private async load() {
    out.appendLine('[ui] load() starting');
    this.loading = true;
    this.onDidChangeEmitter.fire();
    try {
      out.appendLine('[ui] calling listWorkspaces()...');
      const workspaces = await listWorkspaces();
      out.appendLine(`[ui] listWorkspaces() returned ${workspaces.length} items`);
      this.items = workspaces.map((ws) => new WorkspaceTreeItem(ws));
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err;
      this.items = [];
      out.appendLine(`[ui] failed to load workspaces: ${String(err)}`);
    } finally {
      this.loading = false;
      this.loadedOnce = true;
      this.onDidChangeEmitter.fire();
    }
  }

  private createInfoItem(text: string): vscode.TreeItem {
    const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'info';
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  private createErrorItem(error: unknown): vscode.TreeItem {
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

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === 'string' ? error : 'Unable to load workspaces';
  }
}
