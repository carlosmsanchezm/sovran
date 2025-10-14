const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

async function submitWorkspaceViaPlatformApi(workspaceId, opts) {
  const debugLogs = process.env.AEGIS_E2E_DEBUG === '1';
  const protoPath = path.resolve(__dirname, '../../proto/aegis_platform.proto');
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

async function provisionWorkspaceIfNeeded() {
  if (process.env.AEGIS_WORKSPACE_ID) {
    return { workspaceId: process.env.AEGIS_WORKSPACE_ID, cleanup: async () => {} };
  }

  const { execa } = await import('execa');

  const namespace = process.env.AEGIS_PLATFORM_NAMESPACE || 'default';
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
    image: process.env.AEGIS_TEST_IMAGE,
    clusterId: process.env.AEGIS_TEST_CLUSTER_ID,
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
  const pollTimeoutMs = 60_000;
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
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!podsFound) {
    throw new Error(`Timed out waiting for pods with selector ${selector} to appear`);
  }

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
  process.exit(1);
});
