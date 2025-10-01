import * as vscode from 'vscode';

export const out = vscode.window.createOutputChannel('Aegis Remote');

export class Status {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  set(text: string, tooltip?: string) { this.item.text = text; this.item.tooltip = tooltip; this.item.show(); }
}
export const status = new Status();

export class WorkspacesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private onDidChange = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this.onDidChange.event;
  refresh() { this.onDidChange.fire(); }
  getTreeItem(e: vscode.TreeItem) { return e; }
  getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    return [
      new vscode.TreeItem('w-1234', vscode.TreeItemCollapsibleState.None)
    ].map(i => { i.contextValue = 'workspace'; i.command = { command: 'aegis.connect', title: 'Connect', arguments: ['w-1234'] }; return i; });
  }
}
