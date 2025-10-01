/// <reference path="../vscode.proposed.resolvers.d.ts" />
import * as vscode from 'vscode';
import { out, status, WorkspacesProvider } from './ui';
import { AegisResolver } from './resolver';

export function activate(ctx: vscode.ExtensionContext) {
  out.appendLine('Aegis Remote activated');
  status.set('$(circle-outline) Aegis: Idle');

  // Register resolver for "aegis" authority
  ctx.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver('aegis', AegisResolver));

  // TreeView
  const provider = new WorkspacesProvider();
  ctx.subscriptions.push(vscode.window.createTreeView('aegis.workspaces', { treeDataProvider: provider }));

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aegis.showLogs', () => out.show()),
    vscode.commands.registerCommand('aegis.disconnect', () => vscode.commands.executeCommand('workbench.action.closeWindow')),
    vscode.commands.registerCommand('aegis.connect', async (wid?: string) => {
      const selected = wid || 'w-1234';
      const uri = vscode.Uri.parse(`vscode-remote://aegis+${selected}/home/project`);
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    })
  );
}

export function deactivate() {}
