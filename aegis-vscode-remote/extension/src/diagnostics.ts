import * as vscode from 'vscode';
import { getSettings } from './config';
import { ConnectionManager } from './connection';
import { out } from './ui';

export function registerDiagnostics(ctx: vscode.ExtensionContext, getConnection: () => ConnectionManager | undefined) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aegis.showDiagnostics', () => {
      const settings = getSettings();
      const metrics = getConnection()?.getMetrics();

      out.show(true);
      out.appendLine('[diag] settings=' + JSON.stringify(settings));
      if (metrics) {
        out.appendLine('[diag] metrics=' + JSON.stringify(metrics));
      } else {
        out.appendLine('[diag] metrics=unavailable (no active connection)');
      }
      vscode.window.showInformationMessage('Aegis diagnostics sent to output channel.');
    })
  );
}
