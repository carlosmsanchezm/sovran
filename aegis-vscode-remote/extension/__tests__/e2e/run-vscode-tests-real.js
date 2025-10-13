const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

async function submitWorkspaceViaPlatformApi(workspaceId, opts) {
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

    if (opts.projectId) {
      await callUnary('CreateProject', { project: { id: opts.projectId } });
    }

    const flavorName = opts.flavor ?? 'cpu-small';
    await callUnary('UpsertFlavor', { flavor: { name: flavorName } });

    await callUnary('UpsertQueue', {
      queue: {
        name: opts.queue ?? 'default',
        project_id: opts.projectId,
        allowed_flavors: [flavorName],
      },
    });

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

    await new Promise((resolve, reject) => {
      client.SubmitWorkload({ workload: workloadPayload }, metadata, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
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

  await submitWorkspaceViaPlatformApi(workspaceId, {
    grpcAddr,
    token,
    email,
    namespace,
    projectId,
    caPath,
    skipTls: skipTlsVerify,
    queue: process.env.AEGIS_TEST_QUEUE || 'default',
    flavor: process.env.AEGIS_TEST_FLAVOR || 'cpu-small',
    image: process.env.AEGIS_TEST_IMAGE,
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
