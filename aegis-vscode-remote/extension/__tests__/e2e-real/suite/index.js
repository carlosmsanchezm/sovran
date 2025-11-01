"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const vscode = __importStar(require("vscode"));
const keycloak_login_1 = require("./lib/keycloak-login");
const extensionRoot = path.resolve(__dirname, '../../../');
const defaultSessionPath = path.resolve(extensionRoot, '__tests__/e2e-real/.workspace-session.json');
const sessionPath = process.env.AEGIS_WORKSPACE_OUTPUT || defaultSessionPath;
const caFromSessionPath = path.resolve(extensionRoot, '__tests__/e2e-real/workspace-ca-from-session.pem');
function runHelperScript(args) {
    const scriptPath = path.resolve(extensionRoot, 'scripts/prepare-real-workspace.ts');
    const execArgs = ['-r', 'ts-node/register', scriptPath, ...args];
    const result = (0, child_process_1.spawnSync)(process.execPath, execArgs, {
        cwd: extensionRoot,
        stdio: 'inherit',
        env: process.env,
    });
    if (result.error) {
        console.warn('[real-e2e] helper invocation failed', result.error);
    }
    return result.status ?? 0;
}
function cleanupWorkspaceOnce(session) {
    if (cleanupWorkspaceOnce.alreadyRan) {
        return;
    }
    cleanupWorkspaceOnce.alreadyRan = true;
    try {
        const resultCode = runHelperScript([
            '--mode',
            'cleanup',
            '--session-file',
            sessionPath,
        ]);
        if (resultCode !== 0) {
            console.warn('[real-e2e] cleanup helper exited with code', resultCode);
        }
        else {
            console.log('[real-e2e] cleanup helper completed for workspace', session.workspace_id);
        }
    }
    catch (err) {
        console.warn('[real-e2e] cleanup helper threw', err);
    }
}
function decodeJwtClaims(token) {
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
        return JSON.parse(decoded.toString('utf8'));
    }
    catch {
        return undefined;
    }
}
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
let sessionPayload;
function buildWebSocketUrl(rawProxyUrl, workspaceId) {
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
        }
        else if (trimmedPath === '/proxy') {
            base.pathname = suffix;
        }
        else if (trimmedPath.endsWith('/proxy')) {
            base.pathname = `${trimmedPath}/${encodedWid}`;
        }
        else if (!trimmedPath.includes('/proxy/')) {
            const normalized = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
            base.pathname = `${normalized}${suffix}`;
        }
        else {
            base.pathname = trimmedPath;
        }
    }
    else {
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
        sessionPayload = JSON.parse(raw);
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
        }
        else if (sessionPayload.ca_pem && sessionPayload.ca_pem.trim().length > 0) {
            fs.mkdirSync(path.dirname(caFromSessionPath), { recursive: true });
            fs.writeFileSync(caFromSessionPath, sessionPayload.ca_pem, 'utf8');
            process.env.AEGIS_CA_PEM = caFromSessionPath;
        }
        else {
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
        const listProjectWorkloadsCli = async () => {
            const tsNodeRegister = require.resolve('ts-node/register');
            const scriptPath = path.resolve(extensionRoot, 'scripts/prepare-real-workspace.ts');
            try {
                const { stdout } = await execFileAsync(process.execPath, ['-r', tsNodeRegister, scriptPath, '--mode', 'list'], {
                    cwd: extensionRoot,
                    env: process.env,
                });
                const parsed = JSON.parse(stdout);
                return Array.isArray(parsed?.items) ? parsed.items : [];
            }
            catch (err) {
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
        }
        else {
            await cfg.update('security.rejectUnauthorized', false, true);
        }
        const originalOpenExternal = vscode.env.openExternal;
        const expectedUserEmail = sessionPayload?.user_email?.toLowerCase();
        let sessionSubject;
        try {
            const extension = vscode.extensions.getExtension('aegis.aegis-remote');
            assert.ok(extension, 'extension not found');
            if (!extension.isActive) {
                await extension.activate();
            }
            const outDir = path.resolve(__dirname, '../../../out');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const platform = require(path.join(outDir, 'platform.js'));
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const connectionModule = require(path.join(outDir, 'connection.js'));
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const authModule = require(path.join(outDir, 'auth.js'));
            vscode.env.openExternal = async (uri) => {
                const url = uri.toString();
                if (uri.scheme === 'https' && url.includes('keycloak')) {
                    const loginUsername = process.env.AEGIS_TEST_USERNAME ?? '';
                    const loginPassword = process.env.AEGIS_TEST_PASSWORD ?? '';
                    if (!loginUsername || !loginPassword) {
                        throw new Error('AEGIS_TEST_USERNAME and AEGIS_TEST_PASSWORD must be set for Keycloak login');
                    }
                    const loginResult = await (0, keycloak_login_1.performKeycloakLogin)(url, {
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
            const sessionEmailClaim = typeof accessTokenClaims?.email === 'string' ? accessTokenClaims.email : undefined;
            if (expectedUserEmail && derivedUser) {
                assert.strictEqual(derivedUser.toLowerCase(), expectedUserEmail, 'Authenticated session user does not match workspace session payload');
            }
            if (expectedUserEmail && sessionEmailClaim) {
                assert.strictEqual(sessionEmailClaim.toLowerCase(), expectedUserEmail, 'Authenticated session email claim does not match workspace session payload');
            }
            assert.ok(sessionSubject, 'Authenticated session access token is missing a subject claim');
            const availableWorkspaces = await platform.listWorkspaces();
            assert.ok(Array.isArray(availableWorkspaces), 'listWorkspaces did not return an array');
            const listedWorkspace = availableWorkspaces.find((ws) => ws?.id === workspaceId);
            assert.ok(listedWorkspace, `Provisioned workspace ${workspaceId} not returned by listWorkspaces()`);
            const available = await platform.listWorkspaces();
            assert.ok(Array.isArray(available), 'listWorkspaces did not return an array');
            const matched = available.find((item) => item?.id === workspaceId);
            assert.ok(matched, `Provisioned workspace ${workspaceId} not returned by listWorkspaces()`);
            const maxAttempts = Number.parseInt(process.env.AEGIS_PROXY_CONNECT_ATTEMPTS ?? '3', 10);
            const retryDelayMs = Number.parseInt(process.env.AEGIS_PROXY_CONNECT_RETRY_DELAY_MS ?? '5000', 10);
            let attempt = 0;
            let lastError;
            while (attempt < Math.max(maxAttempts, 1)) {
                attempt += 1;
                try {
                    const ticket = await platform.issueProxyTicket(workspaceId);
                    assert.ok(ticket?.proxyUrl, 'issueProxyTicket did not return proxyUrl');
                    assert.ok(ticket?.jwt, 'issueProxyTicket did not return jwt');
                    if (process.env.AEGIS_E2E_DEBUG === '1') {
                        console.log('[real-e2e] ticket material', {
                            hasCa: Boolean(ticket?.caPem),
                            hasCert: Boolean(ticket?.certPem),
                            hasKey: Boolean(ticket?.keyPem),
                            serverName: ticket?.serverName ?? null,
                        });
                    }
                    const ticketClaims = decodeJwtClaims(ticket.jwt);
                    const ticketSubject = typeof ticketClaims?.sub === 'string' ? ticketClaims.sub : undefined;
                    const ticketEmailClaim = typeof ticketClaims?.email === 'string' ? ticketClaims.email : undefined;
                    assert.ok(ticketSubject, 'Proxy ticket missing subject claim');
                    assert.ok(sessionSubject, 'Authenticated session missing subject claim');
                    assert.strictEqual(ticketSubject, sessionSubject, 'Proxy ticket subject does not match authenticated session');
                    if (expectedUserEmail && ticketEmailClaim) {
                        assert.strictEqual(ticketEmailClaim.toLowerCase(), expectedUserEmail, 'Proxy ticket email claim does not match workspace session payload');
                    }
                    const url = buildWebSocketUrl(ticket.proxyUrl, workspaceId);
                    console.log(`[real-e2e] proxyUrl from ticket attempt ${attempt}`, ticket.proxyUrl);
                    console.log('[real-e2e] websocket endpoint', url);
                    const tls = {};
                    if (ticket.caPem)
                        tls.ca = Buffer.from(ticket.caPem);
                    if (ticket.certPem)
                        tls.cert = Buffer.from(ticket.certPem);
                    if (ticket.keyPem)
                        tls.key = Buffer.from(ticket.keyPem);
                    if (ticket.serverName)
                        tls.servername = ticket.serverName;
                    const rejectUnauthorized = (await cfg.get('security.rejectUnauthorized')) !== false;
                    const conn = new connectionModule.ConnectionManager(url, {
                        heartbeatIntervalMs: 500,
                        idleTimeoutMs: 10_000,
                        logLevel: 'debug',
                        log: (msg) => console.log('[real-e2e]', msg),
                        headers: { Authorization: `Bearer ${ticket.jwt}` },
                        tls,
                        rejectUnauthorized,
                    });
                    let transport;
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
                    }
                    finally {
                        const current = transport;
                        if (current) {
                            const closed = new Promise((resolve) => current.onDidClose(() => resolve()));
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
                }
                catch (err) {
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
        }
        finally {
            vscode.env.openExternal = originalOpenExternal;
        }
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zdWl0ZS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLCtDQUFpQztBQUNqQywyQ0FBNkI7QUFDN0IsdUNBQXlCO0FBQ3pCLGlEQUFvRDtBQUNwRCwrQkFBaUM7QUFDakMsK0NBQWlDO0FBQ2pDLHlEQUE0RDtBQUU1RCxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQztBQUMzRCxNQUFNLGtCQUFrQixHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsYUFBYSxFQUFFLDRDQUE0QyxDQUFDLENBQUM7QUFDckcsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsSUFBSSxrQkFBa0IsQ0FBQztBQUM3RSxNQUFNLGlCQUFpQixHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsYUFBYSxFQUFFLGtEQUFrRCxDQUFDLENBQUM7QUFpQjFHLFNBQVMsZUFBZSxDQUFDLElBQWM7SUFDckMsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxhQUFhLEVBQUUsbUNBQW1DLENBQUMsQ0FBQztJQUNwRixNQUFNLFFBQVEsR0FBRyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRSxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUNqRSxNQUFNLE1BQU0sR0FBRyxJQUFBLHlCQUFTLEVBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUU7UUFDbkQsR0FBRyxFQUFFLGFBQWE7UUFDbEIsS0FBSyxFQUFFLFNBQVM7UUFDaEIsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHO0tBQ2pCLENBQUMsQ0FBQztJQUNILElBQUksTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2pCLE9BQU8sQ0FBQyxJQUFJLENBQUMscUNBQXFDLEVBQUUs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