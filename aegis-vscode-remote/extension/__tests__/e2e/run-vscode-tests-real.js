const path = require('path');
const fs = require('fs');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const protoPath = path.resolve(__dirname, '../../proto/aegis_platform.proto');
const logTailLines = Number.parseInt(process.env.AEGIS_E2E_LOG_TAIL || '2000', 10);
const parseJson = (value, fallback) => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
};

async function resolveVsCodeCommit(quality) {
  const debugLogs = process.env.AEGIS_E2E_DEBUG === '1';
  try {
    const vsRoot = await downloadAndUnzipVSCode(quality);
    const candidates = [
      path.join(vsRoot, 'resources', 'app', 'product.json'),
      path.join(vsRoot, 'Contents', 'Resources', 'app', 'product.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const product = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (product?.commit) {
          if (debugLogs) {
            // eslint-disable-next-line no-console
            console.log('[real-e2e] resolved VS Code commit', product.commit);
          }
          return product.commit;
        }
      }
    }
  } catch (err) {
    if (debugLogs) {
      // eslint-disable-next-line no-console
      console.warn('[real-e2e] failed to resolve VS Code commit:', err);
    }
  }
  return undefined;
}

async function submitWorkspaceViaPlatformApi(workspaceId, opts) {
  const debugLogs = process.env.AEGIS_E2E_DEBUG === '1';
  const packageDefinition = await protoLoader.load(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  const platformPkg = loaded?.aegis?.v1;
  if (!platformPkg || !platformPkg.AegisPlatform) {
    throw new Error('Failed to load AegisPlatform proto definition');
  }

  const useTls = !opts.skipTls && opts.caPath;
  let credentials;
  if (useTls) {
    const ca = fs.readFileSync(opts.caPath);
    credentials = grpc.credentials.createSsl(ca);
  } else if (opts.skipTls) {
    credentials = grpc.credentials.createInsecure();
  } else {
    credentials = grpc.credentials.createSsl();
  }

  const client = new platformPkg.AegisPlatform(opts.grpcAddr, credentials);
  try {
    const metadata = new grpc.Metadata();
    if (opts.token) {
      metadata.add('authorization', `Bearer ${opts.token}`);
    }
    if (opts.email) {
      metadata.add('x-aegis-user', opts.email);
    }
    if (opts.namespace) {
      metadata.add('x-aegis-namespace', opts.namespace);
    }

    const callUnary = (method, request) => new Promise((resolve, reject) => {
      client[method](request, metadata, (err, response) => {
        if (err) {
          if (err.code === grpc.status.ALREADY_EXISTS) {
            resolve(response);
            return;
          }
          reject(err);
        } else {
          resolve(response);
        }
      });
    });

    let projectResp;
    if (opts.projectId) {
      projectResp = await callUnary('CreateProject', {
        project: {
          id: opts.projectId,
          display_name: opts.projectDisplayName,
          owner_group: opts.projectOwnerGroup,
          policy: opts.projectPolicy,
        }
      });
      if (debugLogs && projectResp) {
        // eslint-disable-next-line no-console
        console.log('Project response:', JSON.stringify(projectResp));
      }
    }

    const flavorName = opts.flavor ?? 'cpu-small';
    const flavorResp = await callUnary('UpsertFlavor', { flavor: { name: flavorName } });
    if (debugLogs && flavorResp) {
      // eslint-disable-next-line no-console
      console.log('Flavor response:', JSON.stringify(flavorResp));
    }

    const queueResp = await callUnary('UpsertQueue', {
      queue: {
        name: opts.queue ?? 'default',
        project_id: opts.projectId,
        allowed_flavors: [flavorName],
      },
    });
    if (debugLogs && queueResp) {
      // eslint-disable-next-line no-console
      console.log('Queue response:', JSON.stringify(queueResp));
    }

    if (opts.clusterRegistration && opts.clusterId) {
      const clusterReq = {
        cluster_id: opts.clusterId,
        provider: opts.clusterRegistration.provider || 'aws',
        region: opts.clusterRegistration.region || 'us-east-1',
        il_level: opts.clusterRegistration.ilLevel || 'il1',
        labels: opts.clusterRegistration.labels || {},
      };
      const registerResp = await callUnary('RegisterCluster', clusterReq).catch((err) => {
        if (err && err.code === grpc.status.ALREADY_EXISTS) {
          return null;
        }
        throw err;
      });
      if (debugLogs && registerResp) {
        // eslint-disable-next-line no-console
        console.log('RegisterCluster response:', JSON.stringify(registerResp));
      }

      const heartbeatReq = {
        cluster_id: opts.clusterId,
        available_flavors: opts.clusterRegistration.availableFlavors || [{ name: flavorName }],
      };
      if (typeof opts.clusterRegistration.ttfGpuSecondsP50 === 'number') {
        heartbeatReq.ttf_gpu_seconds_p50 = opts.clusterRegistration.ttfGpuSecondsP50;
      }
      const heartbeatResp = await callUnary('Heartbeat', heartbeatReq);
      if (debugLogs && heartbeatResp) {
        // eslint-disable-next-line no-console
        console.log('Heartbeat response:', JSON.stringify(heartbeatResp));
      }
    }

    const workloadPayload = {
      id: workspaceId,
      project_id: opts.projectId,
      queue: opts.queue ?? 'default',
      workspace: {
        flavor: flavorName,
        interactive: true,
        ports: [11111],
        command: opts.workspaceCommand,
        ...(opts.workspaceEnv ? { env: opts.workspaceEnv } : {}),
      },
    };
    if (opts.image) {
      workloadPayload.workspace.image = opts.image;
    }
    if (opts.clusterId) {
      workloadPayload.cluster_id = opts.clusterId;
    }

    const maxAttempts = Number.parseInt(process.env.AEGIS_WORKSPACE_SUBMIT_ATTEMPTS || '12', 10);
    const retryDelayMs = Number.parseInt(process.env.AEGIS_WORKSPACE_SUBMIT_DELAY_MS || '10000', 10);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await new Promise((resolve, reject) => {
          client.SubmitWorkload({ workload: workloadPayload }, metadata, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
        break;
      } catch (err) {
        const isClusterClientError = err
          && err.code === grpc.status.INTERNAL
          && typeof err.details === 'string'
          && err.details.includes('failed to resolve cluster client');
        if (!isClusterClientError || attempt >= maxAttempts) {
          throw err;
        }
        const delay = Math.max(retryDelayMs, 1000);
        // give the agent time to register with the control plane
        await sleep(delay);
      }
    }
  } finally {
    client.close();
  }
}

async function ensureWorkspaceRunning(workspaceId, opts) {
  const debugLogs = process.env.AEGIS_E2E_DEBUG === '1';
  const packageDefinition = await protoLoader.load(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  const platformPkg = loaded?.aegis?.v1;
  if (!platformPkg || !platformPkg.AegisPlatform) {
    throw new Error('Failed to load AegisPlatform proto definition');
  }

  const useTls = !opts.skipTls && opts.caPath;
  let credentials;
  if (useTls) {
    const ca = fs.readFileSync(opts.caPath);
    credentials = grpc.credentials.createSsl(ca);
  } else if (opts.skipTls) {
    credentials = grpc.credentials.createInsecure();
  } else {
    credentials = grpc.credentials.createSsl();
  }

  const client = new platformPkg.AegisPlatform(opts.grpcAddr, credentials);
  try {
    const metadata = new grpc.Metadata();
    if (opts.token) {
      metadata.add('authorization', `Bearer ${opts.token}`);
    }
    if (opts.email) {
      metadata.add('x-aegis-user', opts.email);
    }
    if (opts.namespace) {
      metadata.add('x-aegis-namespace', opts.namespace);
    }

    if (opts.clusterId) {
      await new Promise((resolve, reject) => {
        client.StartWorkload({ id: workspaceId, cluster_id: opts.clusterId }, metadata, (err) => {
          if (err) {
            if (err.code === grpc.status.FAILED_PRECONDITION || err.code === grpc.status.NOT_FOUND) {
              if (debugLogs) {
                // eslint-disable-next-line no-console
                console.warn('[real-e2e] StartWorkload warning:', err.details || err.message);
              }
              resolve();
              return;
            }
            reject(err);
          } else {
            if (debugLogs) {
              // eslint-disable-next-line no-console
              console.log('[real-e2e] StartWorkload invoked for workspace', workspaceId);
            }
            resolve();
          }
        });
      });
    }

    const waitTargetStatus = (process.env.AEGIS_WORKSPACE_EXPECTED_STATUS || 'RUNNING').trim().toUpperCase();
    if (!waitTargetStatus || waitTargetStatus === 'NONE') {
      return;
    }

    const readyTimeoutMs = Number.parseInt(process.env.AEGIS_WORKSPACE_READY_TIMEOUT_MS || '480000', 10);
    const pollIntervalMs = Number.parseInt(process.env.AEGIS_WORKSPACE_READY_POLL_MS || '5000', 10);
    const deadline = Date.now() + Math.max(readyTimeoutMs, 1000);
    let reachedStatus = false;
    while (Date.now() < deadline) {
      try {
        const workload = await new Promise((resolve, reject) => {
          client.GetWorkload({ id: workspaceId }, metadata, (err, response) => {
            if (err) {
              reject(err);
            } else {
              resolve(response);
            }
          });
        });
        const status = (workload?.status || '').toUpperCase();
        if (status === waitTargetStatus) {
          reachedStatus = true;
          if (debugLogs) {
            // eslint-disable-next-line no-console
            console.log('[real-e2e] workspace status reached', waitTargetStatus);
          }
          break;
        }
        if (status === 'FAILED') {
          throw new Error(`Workspace ${workspaceId} failed before reaching ${waitTargetStatus}`);
        }
      } catch (err) {
        if (debugLogs) {
          // eslint-disable-next-line no-console
          console.warn('[real-e2e] waiting for workspace status:', err);
        }
      }
      await sleep(Math.max(pollIntervalMs, 1000));
    }
    if (!reachedStatus) {
      throw new Error(`Timed out waiting for workspace ${workspaceId} to reach status ${waitTargetStatus}`);
    }
  } finally {
    client.close();
  }
}

async function provisionWorkspaceIfNeeded() {
  if (process.env.AEGIS_WORKSPACE_ID) {
    return { workspaceId: process.env.AEGIS_WORKSPACE_ID, cleanup: async () => {} };
  }

  const debugLogs = process.env.AEGIS_E2E_DEBUG === '1';
  const { execa } = await import('execa');

  const namespace = process.env.AEGIS_WORKLOAD_NAMESPACE
    || process.env.AEGIS_PLATFORM_NAMESPACE
    || 'default';
  const projectId = process.env.AEGIS_PROJECT_ID;
  if (!projectId) {
    throw new Error('AEGIS_PROJECT_ID must be set to auto-provision a workspace');
  }

  const workspaceId = `w-e2e-${Math.random().toString(16).slice(2, 10)}`;

  const grpcAddr = process.env.AEGIS_GRPC_ADDR;
  if (!grpcAddr) {
    throw new Error('AEGIS_GRPC_ADDR must be set');
  }
  const token = process.env.AEGIS_TEST_TOKEN;
  const email = process.env.AEGIS_TEST_EMAIL;
  const clusterId = process.env.AEGIS_TEST_CLUSTER_ID;
  const caPath = process.env.AEGIS_CA_PEM && process.env.AEGIS_CA_PEM.trim() !== ''
    ? process.env.AEGIS_CA_PEM.trim()
    : undefined;
  const skipTlsVerify = process.env.AEGIS_TLS_SKIP_VERIFY === '1';

  const policyRegions = (process.env.AEGIS_PROJECT_POLICY_REGIONS || 'us-east-1')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const projectPolicy = {
    regions: policyRegions,
    data_level: process.env.AEGIS_PROJECT_POLICY_DATA_LEVEL || 'il1',
    deny_egress_by_default: process.env.AEGIS_PROJECT_POLICY_DENY_EGRESS === '1',
  };

  const vsQuality = (process.env.VSCODE_QUALITY || 'stable').toLowerCase();
  let vsCommit = process.env.VSCODE_COMMIT;
  if (!vsCommit) {
    vsCommit = await resolveVsCodeCommit(vsQuality);
  }

  const defaultWorkspaceCommand = [
    '/bin/sh',
    '-c',
    `
set -euo pipefail

log() { printf '[reh] %s\\n' "$1"; }

ensure_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$1" >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update >/dev/null 2>&1
    apt-get install -y "$1" >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$1" >/dev/null 2>&1 || true
  fi
}

ensure_tool curl
ensure_tool tar
ensure_tool gzip

WORKDIR="/reh"
mkdir -p "$WORKDIR"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_SUFFIX="x64" ;;
  aarch64|arm64) ARCH_SUFFIX="arm64" ;;
  *)
    log "unsupported architecture: $ARCH"
    exit 1
    ;;
esac

QUALITY="\${VSCODE_QUALITY:-stable}"
COMMIT="\${VSCODE_COMMIT:-}"
TMP_TAR="$(mktemp)"
if [ -n "$COMMIT" ]; then
  PRIMARY_URL="https://vscode.download.prss.microsoft.com/dbazure/download/\${QUALITY}/\${COMMIT}/vscode-server-linux-\${ARCH_SUFFIX}.tar.gz"
  FALLBACK_URL="https://update.code.visualstudio.com/commit/\${COMMIT}/server-linux-\${ARCH_SUFFIX}/\${QUALITY}"
else
  log "VSCODE_COMMIT not set; using latest build for QUALITY=\${QUALITY}"
  PRIMARY_URL="https://update.code.visualstudio.com/latest/server-linux-\${ARCH_SUFFIX}/\${QUALITY}"
  FALLBACK_URL="\${PRIMARY_URL}"
fi

if ! curl -fsSL "$PRIMARY_URL" -o "$TMP_TAR"; then
  log "primary VS Code server download failed, trying fallback"
  curl -fsSL "$FALLBACK_URL" -o "$TMP_TAR"
fi

rm -rf "$WORKDIR/bin/current"
mkdir -p "$WORKDIR/bin/current"
tar -xzf "$TMP_TAR" -C "$WORKDIR/bin/current" --strip-components=1
rm -f "$TMP_TAR"

TOKEN_PATH="$WORKDIR/token"
echo "token" > "$TOKEN_PATH"

log "Extension host agent started"

SERVER_BIN="code-server"
if [ "$QUALITY" = "insider" ] || [ "$QUALITY" = "insiders" ]; then
  SERVER_BIN="code-server-insiders"
fi

exec "$WORKDIR/bin/current/bin/$SERVER_BIN" \\
  --host 0.0.0.0 \\
  --port 11111 \\
  --telemetry-level off \\
  --connection-token-file "$TOKEN_PATH" \\
  --accept-server-license-terms \\
  --disable-telemetry
`
  ];

  const workspaceCommand = (() => {
    const raw = process.env.AEGIS_TEST_WORKSPACE_COMMAND;
    if (!raw) {
      return defaultWorkspaceCommand;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed;
      }
    } catch (err) {
      console.warn('[real-e2e] failed to parse AEGIS_TEST_WORKSPACE_COMMAND; falling back to default', err);
    }
    return defaultWorkspaceCommand;
  })();

  await submitWorkspaceViaPlatformApi(workspaceId, {
    grpcAddr,
    token,
    email,
    namespace,
    projectId,
    projectDisplayName: process.env.AEGIS_PROJECT_DISPLAY_NAME || 'Cloud E2E',
    projectOwnerGroup: process.env.AEGIS_PROJECT_OWNER_GROUP || 'aegis-dev',
    projectPolicy,
    caPath,
    skipTls: skipTlsVerify,
    queue: process.env.AEGIS_TEST_QUEUE || 'default',
    flavor: process.env.AEGIS_TEST_FLAVOR || 'cpu-small',
    image: process.env.AEGIS_TEST_IMAGE || '567751785679.dkr.ecr.us-east-1.amazonaws.com/aegis/workspace-vscode:latest',
    workspaceCommand,
    workspaceEnv: {
      VSCODE_QUALITY: vsQuality,
      ...(vsCommit ? { VSCODE_COMMIT: vsCommit } : {}),
    },
    clusterId,
    clusterRegistration: {
      provider: process.env.AEGIS_CLUSTER_PROVIDER || 'aws',
      region: process.env.AEGIS_CLUSTER_REGION || 'us-east-1',
      ilLevel: process.env.AEGIS_CLUSTER_IL_LEVEL || 'il1',
      labels: {
        env: namespace,
        ...parseJson(process.env.AEGIS_CLUSTER_LABELS, {}),
      },
      availableFlavors: [{
        name: process.env.AEGIS_TEST_FLAVOR || 'cpu-small'
      }],
    },
  });

  const waitTimeout = process.env.AEGIS_TEST_WORKSPACE_TIMEOUT || '300s';
  const selector = `aegis.workload/id=${workspaceId}`;

  const pollStart = Date.now();
  const pollTimeoutMs = Number.parseInt(process.env.AEGIS_WORKSPACE_APPEAR_TIMEOUT_MS || '180000', 10);
  const pollIntervalMs = 2_000;
  let podsFound = false;
  let podName;
  while (Date.now() - pollStart < pollTimeoutMs) {
    const { stdout } = await execa('kubectl', [
      'get',
      'pods',
      '-l',
      selector,
      '-n',
      namespace,
      '-o',
      'name'
    ]);
    if (stdout && stdout.trim().length > 0) {
      podsFound = true;
      podName = stdout.trim().split('\n')[0].replace(/^pod\//, '');
      if (debugLogs) {
        // eslint-disable-next-line no-console
        console.log('[real-e2e] workspace pod discovered:', podName);
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!podsFound) {
    try {
      const snapshotArgs = ['get', 'aegisworkloads.aegis.yourorg.dev', '-A', '-o', 'yaml'];
      const { stdout: workloads } = await execa('kubectl', snapshotArgs);
      // eslint-disable-next-line no-console
      console.warn('AegisWorkloads snapshot:\n', workloads);
    } catch (snapErr) {
      // eslint-disable-next-line no-console
      console.warn('Failed to get AegisWorkloads snapshot', snapErr);
    }
    throw new Error(`Timed out waiting for pods with selector ${selector} to appear`);
  }

  try {
    await execa('kubectl', [
      'wait',
      '--for=condition=Ready',
      'pod',
      '-l',
      selector,
      '-n',
      namespace,
      '--timeout',
      waitTimeout
    ], { stdout: 'inherit', stderr: 'inherit' });
  } catch (err) {
    if (podName) {
      try {
        await execa('kubectl', ['get', 'pod', podName, '-n', namespace, '-o', 'wide'], { stdout: 'inherit', stderr: 'inherit' });
      } catch {}
      try {
        await execa('kubectl', ['describe', 'pod', podName, '-n', namespace], { stdout: 'inherit', stderr: 'inherit' });
      } catch {}
      try {
        await execa('kubectl', ['logs', podName, '-n', namespace, '--tail=200', '--timestamps'], { stdout: 'inherit', stderr: 'inherit' });
      } catch {}
      try {
        await execa('kubectl', ['logs', podName, '-n', namespace, '--previous', '--tail=200', '--timestamps'], { stdout: 'inherit', stderr: 'inherit' });
      } catch {}
    }
    throw err;
  }

  if (podName) {
    const deadline = Date.now() + 60_000;
    let logReady = false;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execa('kubectl', [
          'logs',
          podName,
          '-n',
          namespace,
          '--tail=40'
        ]);
        if (stdout.includes('Extension host agent started') || stdout.includes('Extension host agent listening')) {
          logReady = true;
          break;
        }
      } catch (err) {
        // ignore transient issues while logs stream warm up
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!logReady) {
      throw new Error('Timed out waiting for workspace VS Code server to start');
    }
    if (debugLogs) {
      // eslint-disable-next-line no-console
      console.log('[real-e2e] workspace log ready detected for pod', podName);
      try {
        const { stdout } = await execa('kubectl', [
          'logs',
          podName,
          '-n',
          namespace,
          '--tail=200'
        ]);
        console.log('---- workspace pod log tail ----');
        console.log(stdout);
        console.log('---- end workspace pod log tail ----');
      } catch (err) {
        console.warn('[real-e2e] failed to read workspace pod logs:', err);
      }
    }
  }

  await ensureWorkspaceRunning(workspaceId, {
    grpcAddr,
    token,
    email,
    namespace,
    clusterId,
    caPath,
    skipTls: skipTlsVerify,
  });

  if (debugLogs) {
    // eslint-disable-next-line no-console
    console.log('[real-e2e] workspace status confirmed RUNNING');
  }

  process.env.AEGIS_WORKSPACE_ID = workspaceId;

  const cleanup = async () => {
    await execa('kubectl', ['delete', 'aegisworkload', workspaceId, '-n', namespace, '--ignore-not-found'], {
      stdout: 'inherit',
      stderr: 'inherit'
    });
  };

  return { workspaceId, cleanup };
}

async function main() {
  const extensionRoot = path.resolve(__dirname, '../../');
  const extensionDevelopmentPath = extensionRoot; // use real compiled extension

  const compiledSuite = path.resolve(extensionRoot, '__tests__/e2e-real/out/run.js');
  const sourceSuite = path.resolve(extensionRoot, '__tests__/e2e-real/suite/run');
  const extensionTestsPath = fs.existsSync(compiledSuite) ? compiledSuite : sourceSuite;

  const userDataDir = path.resolve(extensionRoot, '__tests__/.user-data-real');
  const logsDir = path.resolve(extensionRoot, '__tests__/logs-real');
  fs.mkdirSync(logsDir, { recursive: true });

  const launchArgs = [
    `--user-data-dir=${userDataDir}`,
    `--logsPath=${logsDir}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--enable-proposed-api=aegis.aegis-remote'
  ];

  process.env.MOCHA_REPORTER = process.env.MOCHA_REPORTER || 'mocha-junit-reporter';
  process.env.MOCHA_FILE = process.env.MOCHA_FILE
    || path.resolve(extensionRoot, '__tests__/test-results/junit/mocha-e2e-real-results.xml');

  const workspace = await provisionWorkspaceIfNeeded();
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs
    });
  } finally {
    await workspace.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  if (process.env.AEGIS_E2E_DEBUG === '1') {
    const extensionRoot = path.resolve(__dirname, '../../');
    const renderLog = path.resolve(extensionRoot, '__tests__/logs-real/window1/renderer.log');
    const mainLog = path.resolve(extensionRoot, '__tests__/logs-real/main.log');
    const networkLog = path.resolve(extensionRoot, '__tests__/logs-real/window1/network.log');
    printLogTail(renderLog, 'renderer.log');
    printLogTail(mainLog, 'main.log');
    printLogTail(networkLog, 'network.log');
  }
  process.exit(1);
});

function printLogTail(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const tail = lines.slice(-logTailLines).join('\n');
    console.log(`---- ${label} (last ${Math.min(lines.length, logTailLines)} lines) ----`);
    console.log(tail);
    console.log(`---- end ${label} ----`);
  } catch (err) {
    console.warn(`[real-e2e] failed to read ${label}:`, err);
  }
}
