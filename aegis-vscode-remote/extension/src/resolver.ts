/// <reference path="../vscode.proposed.resolvers.d.ts" />
/// <reference path="../vscode.proposed.tunnels.d.ts" />

import * as vscode from 'vscode';
import { out, status } from './ui';
import WebSocket from 'ws';

function makeManagedConnection(url: string): Thenable<vscode.ManagedMessagePassing> {
  const onDidReceiveMessage = new vscode.EventEmitter<Uint8Array>();
  const onDidClose = new vscode.EventEmitter<Error | undefined>();
  const onDidEnd = new vscode.EventEmitter<void>();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, rejectUnauthorized: false }); // self-signed OK for dev
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      status.set('$(plug) Aegis: Connected');
      out.appendLine(`[client] ws open ${url}`);
      resolve({
        onDidReceiveMessage: onDidReceiveMessage.event,
        onDidClose: onDidClose.event,
        onDidEnd: onDidEnd.event,
        send: (data: Uint8Array) => { ws.send(data); },
        end: () => { ws.close(); }
      });
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
      onDidReceiveMessage.fire(buf);
    });

    ws.on('close', (code, reason) => {
      out.appendLine(`[client] ws close ${code} ${reason}`);
      status.set('$(debug-disconnect) Aegis: Disconnected');
      onDidClose.fire(undefined); onDidEnd.fire();
    });

    ws.on('error', (err) => {
      out.appendLine(`[client] ws error: ${String(err)}`);
      status.set('$(error) Aegis: Error');
      // On error before 'open', reject so VS Code can retry
      reject(err);
    });
  });
}

export const AegisResolver: vscode.RemoteAuthorityResolver = {
  async resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolverResult> {
    // authority is like: "aegis+w-1234"
    const wid = (authority.split('+')[1] || '').trim() || 'w-1234';
    const wssUrl = `wss://127.0.0.1:7001/tunnel?wid=${encodeURIComponent(wid)}`;

    out.appendLine(`[resolver] resolve(${authority}) attempt=${context.resolveAttempt} url=${wssUrl}`);
    status.set('$(sync~spin) Aegis: Connecting…', wssUrl);

    const managed = new vscode.ManagedResolvedAuthority(async () => makeManagedConnection(wssUrl));
    // Optional: pass environment for extension host if needed
    return {
      ...managed,
      extensionHostEnv: { AEGIS_WID: wid, AEGIS_TUNNEL: 'wss' }
    };
  }
};
