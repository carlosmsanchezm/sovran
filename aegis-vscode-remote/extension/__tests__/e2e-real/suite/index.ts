import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

function buildWebSocketUrl(rawProxyUrl: string, workspaceId: string): string {
  if (!rawProxyUrl) {
    throw new Error('Proxy URL missing from ticket');
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawProxyUrl);
  const base = new URL(hasScheme ? rawProxyUrl : `https://${rawProxyUrl}`);
  const encodedWid = encodeURIComponent(workspaceId);
  const suffix = `/proxy/${encodedWid}`;
  const trimmedPath = base.pathname.replace(/\/+$/, '');

  const alreadyHasSuffix = trimmedPath === suffix
    || trimmedPath === `/proxy/${workspaceId}`
    || trimmedPath.endsWith(`/proxy/${workspaceId}`)
    || trimmedPath.endsWith(`/proxy/${encodedWid}`);

  if (!alreadyHasSuffix) {
    if (trimmedPath === '' || trimmedPath === '/') {
      base.pathname = suffix;
    } else if (trimmedPath === '/proxy') {
      base.pathname = suffix;
    } else if (trimmedPath.endsWith('/proxy')) {
      base.pathname = `${trimmedPath}/${encodedWid}`;
    } else if (!trimmedPath.includes('/proxy/')) {
      const normalized = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
      base.pathname = `${normalized}${suffix}`;
    } else {
      base.pathname = trimmedPath;
    }
  } else {
    base.pathname = trimmedPath || suffix;
  }

  base.protocol = 'wss:';
  return base.toString();
}

suite('Aegis REAL backend E2E', function () {
  this.timeout(240_000);

  test('sign-in → ticket → heartbeat over real proxy', async () => {
    const email = process.env.AEGIS_TEST_EMAIL ?? '';
    const token = process.env.AEGIS_TEST_TOKEN ?? '';
    const grpcAddr = process.env.AEGIS_GRPC_ADDR ?? '';
    const namespace = process.env.AEGIS_PLATFORM_NAMESPACE ?? 'default';
    const projectId = process.env.AEGIS_PROJECT_ID ?? '';
    const workspaceId = process.env.AEGIS_WORKSPACE_ID ?? '';
    const caPath = process.env.AEGIS_CA_PEM ?? '';

    assert.ok(email, 'AEGIS_TEST_EMAIL not set');
    assert.ok(token, 'AEGIS_TEST_TOKEN not set');
    assert.ok(grpcAddr, 'AEGIS_GRPC_ADDR not set');
    assert.ok(workspaceId, 'AEGIS_WORKSPACE_ID not set');

    const cfg = vscode.workspace.getConfiguration('aegisRemote');
    await cfg.update('platform.grpcEndpoint', grpcAddr, true);
    await cfg.update('platform.namespace', namespace, true);
    if (projectId) {
      await cfg.update('platform.projectId', projectId, true);
    }
    await cfg.update('defaultWorkspaceId', workspaceId, true);
    await cfg.update('heartbeatIntervalMs', 500, true);
    await cfg.update('idleTimeoutMs', 10_000, true);
    await cfg.update('logLevel', 'debug', true);

    if (caPath) {
      await cfg.update('security.caPath', caPath, true);
      await cfg.update('security.rejectUnauthorized', true, true);
    } else {
      await cfg.update('security.rejectUnauthorized', false, true);
    }

    const originalShowInput = vscode.window.showInputBox;
    (vscode.window.showInputBox as any) = async (opts?: vscode.InputBoxOptions) => {
      const prompt = opts?.prompt?.toLowerCase() ?? '';
      if (prompt.includes('email') || prompt.includes('username')) {
        return email;
      }
      return token;
    };

    try {
      const extension = vscode.extensions.getExtension('aegis.aegis-remote');
      assert.ok(extension, 'extension not found');
      if (!extension!.isActive) {
        await extension!.activate();
      }

      const outDir = path.resolve(__dirname, '../../../out');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const platform = require(path.join(outDir, 'platform.js'));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const connectionModule = require(path.join(outDir, 'connection.js'));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const authModule = require(path.join(outDir, 'auth.js'));

      await authModule.requireSession(true);

      const ticket = await platform.issueProxyTicket(workspaceId);
      assert.ok(ticket?.proxyUrl, 'issueProxyTicket did not return proxyUrl');
      assert.ok(ticket?.jwt, 'issueProxyTicket did not return jwt');

      const url = buildWebSocketUrl(ticket.proxyUrl, workspaceId);
      console.log('[real-e2e] proxyUrl from ticket', ticket.proxyUrl);
      console.log('[real-e2e] websocket endpoint', url);
      const tls: Record<string, unknown> = {};
      if (ticket.caPem) tls.ca = Buffer.from(ticket.caPem);
      if (ticket.certPem) tls.cert = Buffer.from(ticket.certPem);
      if (ticket.keyPem) tls.key = Buffer.from(ticket.keyPem);
      if (ticket.serverName) tls.servername = ticket.serverName;

      const rejectUnauthorized = (await cfg.get<boolean>('security.rejectUnauthorized')) !== false;
      const conn = new connectionModule.ConnectionManager(url, {
        heartbeatIntervalMs: 500,
        idleTimeoutMs: 10_000,
        logLevel: 'debug',
        log: (msg: string) => console.log('[real-e2e]', msg),
        headers: { Authorization: `Bearer ${ticket.jwt}` },
        tls,
        rejectUnauthorized,
      });

      const transport = await conn.open();

      const deadline = Date.now() + 60_000;
      let heartbeatSeen = false;
      while (Date.now() < deadline) {
        const metricsSnapshot = conn.getMetrics();
        if (metricsSnapshot.lastHeartbeatAt && metricsSnapshot.lastHeartbeatAt > 0) {
          heartbeatSeen = true;
          console.log('[real-e2e] heartbeat observed', JSON.stringify(metricsSnapshot));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!heartbeatSeen) {
        console.log('[real-e2e] heartbeat metrics before failure', JSON.stringify(conn.getMetrics()));
      }
      assert.ok(heartbeatSeen, 'No heartbeat observed from proxy');

      const closed = new Promise<void>((resolve) => transport.onDidClose(() => resolve()));
      transport.end();
      await closed;

      const metrics = conn.getMetrics();
      assert.ok(metrics.lastClose, 'Expected metrics.lastClose after disconnect');
    } finally {
      (vscode.window.showInputBox as any) = originalShowInput;
    }
  });
});
