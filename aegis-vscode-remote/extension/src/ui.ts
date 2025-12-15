import * as vscode from 'vscode';
import { listWorkspaces, WorkspaceSummary } from './platform';

export const out = vscode.window.createOutputChannel('Aegis Remote');

export class Status {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  set(text: string, tooltip?: string) { this.item.text = text; this.item.tooltip = tooltip; this.item.show(); }
}
export const status = new Status();

/**
 * Gets the currently connected workspace ID by checking if we're in a remote context.
 * Returns undefined if not connected to an Aegis workspace.
 */
export function getConnectedWorkspaceId(): string | undefined {
  // Check if we're in an Aegis remote context
  if (vscode.env.remoteName !== 'aegis') {
    return undefined;
  }

  // Extract workspace ID from the remote authority
  // The authority format is: aegis+<workspace-id>
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const uri = folders[0].uri;
    if (uri.scheme === 'vscode-remote' && uri.authority.startsWith('aegis+')) {
      return uri.authority.substring('aegis+'.length);
    }
  }

  return undefined;
}

/**
 * Returns the appropriate icon and color for a workload status.
 */
function getStatusIcon(status?: string): vscode.ThemeIcon {
  const normalizedStatus = (status ?? '').toUpperCase();
  switch (normalizedStatus) {
    case 'RUNNING':
    case 'READY':
      return new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('charts.green'));
    case 'FAILED':
    case 'ERROR':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'PENDING':
    case 'PLACED':
    case 'STARTING':
    case 'QUEUED':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    case 'STOPPED':
    case 'TERMINATED':
      return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.gray'));
    default:
      return new vscode.ThemeIcon('vm-outline');
  }
}

/**
 * Returns a human-readable status label.
 */
function getStatusLabel(status?: string): string {
  const normalizedStatus = (status ?? '').toUpperCase();
  switch (normalizedStatus) {
    case 'RUNNING':
      return 'Running';
    case 'READY':
      return 'Ready';
    case 'FAILED':
      return 'Failed';
    case 'ERROR':
      return 'Error';
    case 'PENDING':
      return 'Pending';
    case 'PLACED':
      return 'Placed';
    case 'STARTING':
      return 'Starting';
    case 'QUEUED':
      return 'Queued';
    case 'STOPPED':
      return 'Stopped';
    case 'TERMINATED':
      return 'Terminated';
    default:
      return status || 'Unknown';
  }
}

class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(public readonly workspace: WorkspaceSummary, isConnected: boolean) {
    super(workspace.name ?? workspace.id, vscode.TreeItemCollapsibleState.None);

    if (isConnected) {
      this.contextValue = 'workspace-connected';
      this.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('charts.green'));
      this.description = 'Connected';
      // Don't set command - already connected
    } else {
      this.contextValue = 'workspace';
      // Use status-based icon
      this.iconPath = getStatusIcon(workspace.status);

      const descriptionParts: string[] = [];
      // Add status label first
      if (workspace.status) {
        descriptionParts.push(getStatusLabel(workspace.status));
      }
      if (workspace.cluster) descriptionParts.push(workspace.cluster);
      if (workspace.profile) descriptionParts.push(workspace.profile);
      this.description = descriptionParts.join(' · ') || undefined;

      // Only allow connect for running/ready workloads
      const canConnect = ['RUNNING', 'READY'].includes((workspace.status ?? '').toUpperCase());
      if (canConnect) {
        this.command = {
          command: 'aegis.connect',
          title: 'Connect',
          arguments: [workspace.id],
        };
      }
    }
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

      // Check if we're connected to a workspace
      const connectedId = getConnectedWorkspaceId();
      if (connectedId) {
        out.appendLine(`[ui] currently connected to workspace: ${connectedId}`);
      }

      // Sort connected workspace to top
      const sorted = [...workspaces].sort((a, b) => {
        if (a.id === connectedId) return -1;
        if (b.id === connectedId) return 1;
        return 0;
      });

      this.items = sorted.map((ws) => new WorkspaceTreeItem(ws, ws.id === connectedId));
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
