/// <reference path="../vscode.proposed.resolvers.d.ts" />
import * as vscode from 'vscode';
import { out, status, WorkspacesProvider } from './ui';
import { AegisResolver, forceReconnect, getLastConnection } from './resolver';
import { registerDiagnostics } from './diagnostics';
import { getSettings, onDidChangeSettings } from './config';
import { initializeAuth, requireSession, signOut } from './auth';
import { initializePlatform, refreshPlatformSettings } from './platform';

export async function activate(ctx: vscode.ExtensionContext) {
  out.appendLine('Aegis Remote activated');
  status.set('$(circle-outline) Aegis: Idle');

  await initializeAuth(ctx);
  await initializePlatform(ctx);

  ctx.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver('aegis', AegisResolver));
  registerDiagnostics(ctx, getLastConnection);

  const provider = new WorkspacesProvider(ctx);
  const treeView = vscode.window.createTreeView('aegis.workspaces', { treeDataProvider: provider });
  ctx.subscriptions.push(provider, treeView);

  // Handle external URIs from browser (vscode://aegis.aegis-remote/aegis+<workload-id>)
  ctx.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        out.appendLine(`[uri-handler] received URI: ${uri.toString()}`);

        // Extract workspace ID from URI path (format: /aegis+w-xxxxx)
        const match = uri.path.match(/^\/aegis\+(.+)$/);
        if (match) {
          const workspaceId = match[1];
          out.appendLine(`[uri-handler] connecting to workspace: ${workspaceId}`);

          // Ensure user is signed in
          await requireSession(true);

          // Open the workspace in a new window
          const remoteUri = vscode.Uri.parse(`vscode-remote://aegis+${workspaceId}/home/project`);
          await vscode.commands.executeCommand('vscode.openFolder', remoteUri, { forceNewWindow: true });
        } else {
          out.appendLine(`[uri-handler] unrecognized URI format: ${uri.path}`);
        }
      }
    })
  );

  ctx.subscriptions.push(
    onDidChangeSettings(async () => {
      const cfg = getSettings();
      out.appendLine('[settings] updated ' + JSON.stringify(cfg));
      await refreshPlatformSettings();
      provider.refresh();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aegis.showLogs', () => out.show()),
    vscode.commands.registerCommand('aegis.disconnect', () => vscode.commands.executeCommand('workbench.action.closeWindow')),
    vscode.commands.registerCommand('aegis.reconnect', () => {
      forceReconnect();
    }),
    vscode.commands.registerCommand('aegis.connect', async (wid?: string) => {
      await requireSession(true);
      const settings = getSettings();
      const workspaceId = wid || settings.defaultWorkspaceId;
      if (!workspaceId) {
        vscode.window.showErrorMessage('Select a workspace to connect.');
        return;
      }
      const uri = vscode.Uri.parse(`vscode-remote://aegis+${workspaceId}/home/project`);
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('aegis.refreshWorkspaces', () => provider.refresh()),
    vscode.commands.registerCommand('aegis.signIn', async () => {
      await requireSession(true);
      provider.refresh();
    }),
    vscode.commands.registerCommand('aegis.signOut', async () => {
      await signOut();
      provider.refresh();
    })
  );
}

export function deactivate() {}
