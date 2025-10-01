/// <reference path="../vscode.proposed.resolvers.d.ts" />
import * as vscode from 'vscode';
import { out, status, WorkspacesProvider } from './ui';
import { AegisResolver, forceReconnect, getLastConnection } from './resolver';
import { registerDiagnostics } from './diagnostics';
import { getSettings, onDidChangeSettings } from './config';

export function activate(ctx: vscode.ExtensionContext) {
  out.appendLine('Aegis Remote activated');
  status.set('$(circle-outline) Aegis: Idle');

  // Register resolver for "aegis" authority
  ctx.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver('aegis', AegisResolver));
  registerDiagnostics(ctx, getLastConnection);

  ctx.subscriptions.push(
    onDidChangeSettings(() => {
      const cfg = getSettings();
      out.appendLine('[settings] updated ' + JSON.stringify(cfg));
    })
  );

  // TreeView
  const provider = new WorkspacesProvider();
  ctx.subscriptions.push(vscode.window.createTreeView('aegis.workspaces', { treeDataProvider: provider }));

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aegis.showLogs', () => out.show()),
    vscode.commands.registerCommand('aegis.disconnect', () => vscode.commands.executeCommand('workbench.action.closeWindow')),
    vscode.commands.registerCommand('aegis.reconnect', () => {
      forceReconnect();
    }),
    vscode.commands.registerCommand('aegis.connect', async (wid?: string) => {
      const selected = wid || 'w-1234';
      const uri = vscode.Uri.parse(`vscode-remote://aegis+${selected}/home/project`);
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    })
  );
}

export function deactivate() {}
