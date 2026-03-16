/// <reference path="../vscode.proposed.resolvers.d.ts" />
import * as vscode from 'vscode';
import { out, status, WorkspacesProvider } from './ui';
import { AegisResolver, forceReconnect, getLastConnection, revokeCurrentSession } from './resolver';
import { registerDiagnostics } from './diagnostics';
import { getSettings, onDidChangeSettings } from './config';
import { handleAuthUri, initializeAuth, requireSession, signOut, clearAllSecrets } from './auth';
import { initializePlatform, refreshPlatformSettings, fetchPlatformRootCA } from './platform';
import { configureHttpSecurity, disposeHttpSecurity } from './http';
import { isSecureMode, redactSettings } from './secure-mode';
import { promises as fs } from 'fs';
import * as path from 'path';

let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  extensionContext = ctx;
  out.appendLine('Aegis Remote activated');
  if (isSecureMode()) {
    out.appendLine('[secure-mode] ACTIVE — ephemeral tokens, TLS enforced, log level clamped');
  }
  status.set('$(circle-outline) Aegis: Idle');

  const initialSettings = getSettings();

  // Auto-fetch platform root CA if no caPath is configured.
  // Uses HTTPS (system CAs validate ingress cert) to bootstrap trust.
  // Cached in extension storage for subsequent launches.
  if (!initialSettings.security.caPath && initialSettings.platform.grpcEndpoint) {
    const cachedCA = ctx.globalState.get<string>('aegis.cachedRootCA');
    if (cachedCA) {
      out.appendLine(`[platform] using cached root CA (${cachedCA.length} bytes)`);
      const caDir = path.join(ctx.globalStorageUri.fsPath);
      await fs.mkdir(caDir, { recursive: true });
      const caFile = path.join(caDir, 'platform-root-ca.pem');
      await fs.writeFile(caFile, cachedCA);
      initialSettings.security.caPath = caFile;
    } else {
      const ca = await fetchPlatformRootCA(initialSettings.platform.grpcEndpoint);
      if (ca) {
        await ctx.globalState.update('aegis.cachedRootCA', ca);
        const caDir = path.join(ctx.globalStorageUri.fsPath);
        await fs.mkdir(caDir, { recursive: true });
        const caFile = path.join(caDir, 'platform-root-ca.pem');
        await fs.writeFile(caFile, ca);
        initialSettings.security.caPath = caFile;
        out.appendLine(`[platform] auto-configured CA trust from platform PKI endpoint`);
      }
    }
  }

  await configureHttpSecurity(initialSettings.security);

  await initializeAuth(ctx);
  await initializePlatform(ctx);

  ctx.subscriptions.push(new vscode.Disposable(() => { void disposeHttpSecurity(); }));

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
        const handled = await handleAuthUri(uri);
        if (handled) {
          out.appendLine('[uri-handler] handled OAuth callback');
          return;
        }

        // Extract workspace ID from URI path (format: /aegis+w-xxxxx)
        const match = uri.path.match(/^\/aegis\+(.+)$/);
        if (match) {
          const workspaceId = match[1];
          out.appendLine(`[uri-handler] connecting to workspace: ${workspaceId}`);

          // Ensure user is signed in (with retry logic for race condition after OAuth callback)
          let session: vscode.AuthenticationSession | undefined;
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              // First try silently to avoid triggering a new auth flow if session is being stored
              session = await vscode.authentication.getSession('aegis', ['platform'], {
                createIfNone: false,
                silent: true,
              });
              if (session) {
                break;
              }
              // Small delay to allow OAuth completion to finish storing the session
              if (attempt < 4) {
                out.appendLine(`[uri-handler] no session yet, waiting... (attempt ${attempt + 1}/5)`);
                await new Promise(resolve => setTimeout(resolve, 300));
              }
            } catch (err) {
              out.appendLine(`[uri-handler] session check failed: ${String(err)}`);
            }
          }
          // If no session after retries, prompt for sign-in
          if (!session) {
            out.appendLine('[uri-handler] no cached session found, prompting sign-in');
            session = await requireSession(true);
          }
          if (!session) {
            out.appendLine('[uri-handler] sign-in failed or cancelled');
            return;
          }
          out.appendLine(`[uri-handler] authenticated as ${session.account.label}`);

          // Open the workspace in a new window
          const remoteUri = vscode.Uri.parse(`vscode-remote://aegis+${workspaceId}/home/aegis/work`);
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
      out.appendLine('[settings] updated ' + JSON.stringify(redactSettings(cfg)));
      await configureHttpSecurity(cfg.security);
      await refreshPlatformSettings();
      provider.refresh();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aegis.showLogs', () => out.show()),
    vscode.commands.registerCommand('aegis.disconnect', async () => {
      await revokeCurrentSession().catch(() => {});
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    }),
    vscode.commands.registerCommand('aegis.reconnect', () => {
      forceReconnect();
    }),
    vscode.commands.registerCommand('aegis.connect', async (wid?: string, wsRoot?: string) => {
      await requireSession(true);
      const settings = getSettings();
      const workspaceId = wid || settings.defaultWorkspaceId;
      if (!workspaceId) {
        vscode.window.showErrorMessage('Select a workspace to connect.');
        return;
      }
      const root = wsRoot || '/home/aegis/work';
      const uri = vscode.Uri.parse(`vscode-remote://aegis+${workspaceId}${root}`);
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

export function deactivate() {
  // Best-effort revocation of the connection session on extension shutdown.
  // VS Code allows deactivate() to return a promise with a short timeout.
  const revoke = revokeCurrentSession().catch(() => {
    // Swallow errors — this is best-effort cleanup on shutdown
  });

  if (isSecureMode() && extensionContext) {
    return revoke.then(() => clearAllSecrets(extensionContext!).catch(() => {}));
  }
  return revoke;
}
