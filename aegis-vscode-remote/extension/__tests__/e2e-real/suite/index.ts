import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';

const extensionRoot = path.resolve(__dirname, '../../../');
const defaultSessionPath = path.resolve(extensionRoot, '__tests__/e2e-real/.workspace-session.json');
const sessionPath = process.env.AEGIS_WORKSPACE_OUTPUT || defaultSessionPath;
const caFromSessionPath = path.resolve(extensionRoot, '__tests__/e2e-real/workspace-ca-from-session.pem');

interface WorkspaceSessionPayload {
  workspace_id: string;
  project_id: string;
  proxy_url: string;
  jwt: string;
  ca_pem?: string | null;
  ca_file?: string | null;
  namespace?: string | null;
}

function runHelperScript(args: string[]): number {
  const scriptPath = path.resolve(extensionRoot, 'scripts/prepare-real-workspace.ts');
  const execArgs = ['-r', 'ts-node/register', scriptPath, ...args];
  const result = spawnSync(process.execPath, execArgs, {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.warn('[real-e2e] helper invocation failed', result.error);
  }
  return result.status ?? 0;
}

function cleanupWorkspaceOnce(session: WorkspaceSessionPayload): void {
  if ((cleanupWorkspaceOnce as any).alreadyRan) {
    return;
  }
  (cleanupWorkspaceOnce as any).alreadyRan = true;

  try {
    const resultCode = runHelperScript([
      '--mode',
      'cleanup',
      '--session-file',
      sessionPath,
    ]);
    if (resultCode !== 0) {
      console.warn('[real-e2e] cleanup helper exited with code', resultCode);
    } else {
      console.log('[real-e2e] cleanup helper completed for workspace', session.workspace_id);
    }
  } catch (err) {
    console.warn('[real-e2e] cleanup helper threw', err);
  }
}

let sessionPayload: WorkspaceSessionPayload | undefined;

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

  suiteSetup(() => {
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Workspace session file not found at ${sessionPath}`);
    }
    const raw = fs.readFileSync(sessionPath, 'utf8');
    sessionPayload = JSON.parse(raw) as WorkspaceSessionPayload;
    if (!sessionPayload.workspace_id) {
      throw new Error('Workspace session missing workspace_id');
    }
    process.env.AEGIS_WORKSPACE_ID = sessionPayload.workspace_id;
    if (sessionPayload.project_id) {
      process.env.AEGIS_PROJECT_ID = sessionPayload.project_id;
    }
    if (sessionPayload.namespace) {
      process.env.AEGIS_PLATFORM_NAMESPACE = sessionPayload.namespace;
    }

    if (sessionPayload.ca_file && sessionPayload.ca_file.trim().length > 0) {
      process.env.AEGIS_CA_PEM = sessionPayload.ca_file;
    } else if (sessionPayload.ca_pem && sessionPayload.ca_pem.trim().length > 0) {
      fs.mkdirSync(path.dirname(caFromSessionPath), { recursive: true });
      fs.writeFileSync(caFromSessionPath, sessionPayload.ca_pem, 'utf8');
      process.env.AEGIS_CA_PEM = caFromSessionPath;
    } else {
      process.env.AEGIS_CA_PEM = '';
    }

    process.on('exit', () => {
      if (sessionPayload) {
        cleanupWorkspaceOnce(sessionPayload);
      }
    });
    process.on('SIGINT', () => {
      if (sessionPayload) {
        cleanupWorkspaceOnce(sessionPayload);
      }
      process.exit(1);
    });
    process.on('SIGTERM', () => {
      if (sessionPayload) {
        cleanupWorkspaceOnce(sessionPayload);
      }
      process.exit(1);
    });
  });

  suiteTeardown(() => {
    if (sessionPayload) {
      cleanupWorkspaceOnce(sessionPayload);
    }
  });

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
      const available = await platform.listWorkspaces();
      assert.ok(
        Array.isArray(available),
        'listWorkspaces did not return an array',
      );
      const matched = available.find((item: { id?: string }) => item?.id === workspaceId);
      assert.ok(matched, `Provisioned workspace ${workspaceId} not returned by listWorkspaces()`);

      const maxAttempts = Number.parseInt(process.env.AEGIS_PROXY_CONNECT_ATTEMPTS ?? '3', 10);
      const retryDelayMs = Number.parseInt(process.env.AEGIS_PROXY_CONNECT_RETRY_DELAY_MS ?? '5000', 10);
      let attempt = 0;
      let lastError: unknown;

      while (attempt < Math.max(maxAttempts, 1)) {
        attempt += 1;
        try {
          const ticket = await platform.issueProxyTicket(workspaceId);
          assert.ok(ticket?.proxyUrl, 'issueProxyTicket did not return proxyUrl');
          assert.ok(ticket?.jwt, 'issueProxyTicket did not return jwt');

          const url = buildWebSocketUrl(ticket.proxyUrl, workspaceId);
          console.log(`[real-e2e] proxyUrl from ticket attempt ${attempt}`, ticket.proxyUrl);
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

          let transport: { onDidClose: (cb: () => void) => void; end: () => void } | undefined;
          let success = false;
          try {
            transport = await conn.open();
            const deadline = Date.now() + 60_000;
            let heartbeatSeen = false;
            while (Date.now() < deadline) {
              const metricsSnapshot = conn.getMetrics();
              if (metricsSnapshot.lastHeartbeatAt && metricsSnapshot.lastHeartbeatAt > 0) {
                heartbeatSeen = true;
                console.log('[real-e2e] heartbeat observed', JSON.stringify(metricsSnapshot));
                break;
              }
              if ((metricsSnapshot.bytesTx ?? 0) === 0) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                continue;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            if (!heartbeatSeen) {
              console.log('[real-e2e] heartbeat metrics before failure', JSON.stringify(conn.getMetrics()));
              throw new Error('No heartbeat observed from proxy');
            }
            success = true;
          } finally {
            const current = transport;
            if (current) {
              const closed = new Promise<void>((resolve) => current.onDidClose(() => resolve()));
              current.end();
              await closed.catch(() => undefined);
              transport = undefined;
            }
          }
          if (success) {
            const metrics = conn.getMetrics();
            assert.ok(metrics.lastClose, 'Expected metrics.lastClose after disconnect');
            lastError = undefined;
            break;
          }
        } catch (err) {
          lastError = err;
          if (attempt < Math.max(maxAttempts, 1)) {
            console.warn(`[real-e2e] attempt ${attempt} failed, will retry in ${retryDelayMs}ms`, err);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
          break;
        }
      }

      if (lastError) {
        if (lastError instanceof Error) {
          throw lastError;
        }
        throw new Error(String(lastError));
      }
    } finally {
      (vscode.window.showInputBox as any) = originalShowInput;
    }
  });
});
