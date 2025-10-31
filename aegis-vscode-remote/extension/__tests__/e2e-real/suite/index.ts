import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { performKeycloakLogin } from './lib/keycloak-login';

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
  user_email?: string | null;
  metadata?: {
    grpc_addr?: string | null;
  };
  user_token?: string | null;
}

function normalizeUser(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function fingerprint(label: string, value: string | undefined) {
  if (!value) {
    return;
  }
  const hash = createHash('sha256').update(value).digest('hex');
  console.warn(`[real-e2e] ${label} sha256=${hash} len=${value.length}`);
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

interface WorkloadSummary {
  id?: string | null;
  status?: string | null;
}

function decodeJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  const payload = parts[1];
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
  try {
    const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

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
    if (sessionPayload.user_email) {
      process.env.AEGIS_TEST_EMAIL = sessionPayload.user_email;
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
    if (sessionPayload.metadata?.grpc_addr) {
      process.env.AEGIS_GRPC_ADDR = sessionPayload.metadata.grpc_addr;
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

  suiteTeardown(async () => {
    if (sessionPayload) {
      cleanupWorkspaceOnce(sessionPayload);
    }

    const listProjectWorkloadsCli = async (): Promise<WorkloadSummary[]> => {
      const tsNodeRegister = require.resolve('ts-node/register');
      const scriptPath = path.resolve(extensionRoot, 'scripts/prepare-real-workspace.ts');
      try {
        const { stdout } = await execFileAsync(process.execPath, ['-r', tsNodeRegister, scriptPath, '--mode', 'list'], {
          cwd: extensionRoot,
          env: process.env,
        });
        const parsed = JSON.parse(stdout) as { items?: WorkloadSummary[] };
        return Array.isArray(parsed?.items) ? parsed.items : [];
      } catch (err) {
        console.warn('[real-e2e] failed to list workloads via helper', err);
        return [];
      }
    };

    const prefix = process.env.AEGIS_WORKSPACE_ID_PREFIX || 'w-vscode-e2e-';
    const terminalStatuses = new Set(['DELETED', 'FAILED', 'SUCCEEDED', 'CANCELLED']);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const workloads = await listProjectWorkloadsCli();
      const leaked = workloads.filter((item) => {
        const id = (item?.id ?? '').trim();
        if (!id.startsWith(prefix)) {
          return false;
        }
        const status = (item?.status ?? '').toUpperCase();
        return !terminalStatuses.has(status);
      });
      if (leaked.length === 0) {
        return;
      }
      if (attempt === 4) {
        const details = leaked.map((item) => `${item.id ?? 'unknown'}:${item.status ?? 'UNKNOWN'}`).join(', ');
        throw new Error(`Lingering workloads detected after cleanup: ${details}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  });

  test('sign-in → ticket → heartbeat over real proxy', async () => {
    const email = process.env.AEGIS_TEST_EMAIL ?? '';
    const grpcAddr = process.env.AEGIS_GRPC_ADDR ?? '';
    const namespace = process.env.AEGIS_PLATFORM_NAMESPACE ?? 'default';
    const projectId = process.env.AEGIS_PROJECT_ID ?? '';
    const workspaceId = process.env.AEGIS_WORKSPACE_ID ?? '';
    const caPath = process.env.AEGIS_CA_PEM ?? '';
    const username = process.env.AEGIS_TEST_USERNAME ?? '';
    const password = process.env.AEGIS_TEST_PASSWORD ?? '';

    assert.ok(email, 'AEGIS_TEST_EMAIL not set');
    assert.ok(username, 'AEGIS_TEST_USERNAME not set');
    assert.ok(password, 'AEGIS_TEST_PASSWORD not set');
    assert.ok(grpcAddr, 'AEGIS_GRPC_ADDR not set');
    assert.ok(workspaceId, 'AEGIS_WORKSPACE_ID not set');

    const cfg = vscode.workspace.getConfiguration('aegisRemote');
    const disableOfflineFlag = [
      process.env.AEGIS_AUTH_DISABLE_OFFLINE,
      process.env.AEGIS_DISABLE_OFFLINE_SCOPE,
    ]
      .map((value) => (value ?? '').trim().toLowerCase())
      .some((value) => value === '1' || value === 'true' || value === 'yes');
    const scopeConfig = disableOfflineFlag
      ? ['openid', 'profile', 'email']
      : ['openid', 'profile', 'email', 'offline_access'];
    await cfg.update('auth.scopes', scopeConfig, true);
    await cfg.update('platform.grpcEndpoint', grpcAddr, true);
    await cfg.update('platform.namespace', namespace, true);
    if (projectId) {
      await cfg.update('platform.projectId', projectId, true);
    }
    const authority = process.env.AEGIS_AUTH_AUTHORITY ?? 'https://keycloak.localtest.me/realms/aegis';
    const clientId = process.env.AEGIS_AUTH_CLIENT_ID ?? 'vscode-extension';
    const redirectUri = process.env.AEGIS_AUTH_REDIRECT_URI ?? 'vscode://aegis.aegis-remote/auth';

    await cfg.update('auth.authority', authority, true);
    await cfg.update('auth.clientId', clientId, true);
    await cfg.update('auth.redirectUri', redirectUri, true);
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

    const originalOpenExternal = vscode.env.openExternal;
    const expectedUserEmail = normalizeUser(sessionPayload?.user_email);
    let sessionSubject: string | undefined;

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

      (vscode.env.openExternal as any) = async (uri: vscode.Uri) => {
        const url = uri.toString();
        if (uri.scheme === 'https' && url.includes('keycloak')) {
          const loginUsername = process.env.AEGIS_TEST_USERNAME ?? '';
          const loginPassword = process.env.AEGIS_TEST_PASSWORD ?? '';
          if (!loginUsername || !loginPassword) {
            throw new Error('AEGIS_TEST_USERNAME and AEGIS_TEST_PASSWORD must be set for Keycloak login');
          }
          const loginResult = await performKeycloakLogin(url, {
            username: loginUsername,
            password: loginPassword,
            totpSecret: process.env.AEGIS_TEST_TOTP_SECRET,
          });
          await authModule.handleAuthUri(vscode.Uri.parse(loginResult.redirectUri));
          return true;
        }
        return originalOpenExternal.call(vscode.env, uri);
      };

      const authSession = await authModule.requireSession(true);
      assert.ok(authSession, 'Authentication session was not established');
      assert.ok(authSession.accessToken, 'Authentication session missing access token');
      const accessTokenClaims = decodeJwtClaims(authSession.accessToken);
      sessionSubject = typeof accessTokenClaims?.sub === 'string' ? accessTokenClaims.sub : undefined;
      const derivedUser = authModule.getSessionUser(authSession);
      const normalizedDerivedUser = normalizeUser(derivedUser);
      const sessionEmailClaim = typeof accessTokenClaims?.email === 'string' ? accessTokenClaims.email : undefined;
      const normalizedEmailClaim = normalizeUser(sessionEmailClaim);

      if (expectedUserEmail && normalizedDerivedUser) {
        fingerprint('expected-user-email', expectedUserEmail);
        fingerprint('derived-user', normalizedDerivedUser);
        assert.strictEqual(
          normalizedDerivedUser,
          expectedUserEmail,
          'Authenticated session user does not match workspace session payload'
        );
      }
      if (expectedUserEmail && normalizedEmailClaim) {
        fingerprint('token-email-claim', normalizedEmailClaim);
        assert.strictEqual(
          normalizedEmailClaim,
          expectedUserEmail,
          'Authenticated session email claim does not match workspace session payload'
        );
      }

      assert.ok(sessionSubject, 'Authenticated session access token is missing a subject claim');

      const availableWorkspaces = await platform.listWorkspaces();
      assert.ok(Array.isArray(availableWorkspaces), 'listWorkspaces did not return an array');
      const listedWorkspace = availableWorkspaces.find((ws: { id?: string }) => ws?.id === workspaceId);
      assert.ok(listedWorkspace, `Provisioned workspace ${workspaceId} not returned by listWorkspaces()`);
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
        if (process.env.AEGIS_E2E_DEBUG === '1') {
          console.log('[real-e2e] ticket material', {
            hasCa: Boolean(ticket?.caPem),
            hasCert: Boolean((ticket as any)?.certPem),
            hasKey: Boolean((ticket as any)?.keyPem),
            serverName: (ticket as any)?.serverName ?? null,
          });
        }

        const ticketClaims = decodeJwtClaims(ticket.jwt);
        const ticketSubject = typeof ticketClaims?.sub === 'string' ? ticketClaims.sub : undefined;
        const ticketEmailClaim = typeof ticketClaims?.email === 'string' ? ticketClaims.email : undefined;
        const normalizedTicketEmail = normalizeUser(ticketEmailClaim);
        assert.ok(ticketSubject, 'Proxy ticket missing subject claim');
        assert.ok(sessionSubject, 'Authenticated session missing subject claim');
        assert.strictEqual(
          ticketSubject,
          sessionSubject,
          'Proxy ticket subject does not match authenticated session'
        );
        if (expectedUserEmail && normalizedTicketEmail) {
          fingerprint('ticket-email-claim', normalizedTicketEmail);
          assert.strictEqual(
            normalizedTicketEmail,
            expectedUserEmail,
            'Proxy ticket email claim does not match workspace session payload'
          );
        }

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
          const renewal = await platform.issueProxyTicket(workspaceId);
          assert.ok(renewal?.proxyUrl, 'Renewed ticket missing proxy URL');
          assert.ok(renewal?.jwt, 'Failed to renew proxy ticket');
          if (ticket.jwt && renewal?.jwt) {
            assert.notStrictEqual(renewal.jwt, ticket.jwt, 'Renewed proxy ticket should be distinct from initial ticket');
          }
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
      (vscode.env.openExternal as any) = originalOpenExternal;
    }
  });
});
