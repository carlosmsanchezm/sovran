const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

const extensionRoot = path.resolve(__dirname, '../../');
const compiledSuite = path.resolve(extensionRoot, '__tests__/e2e-real/out/run.js');
const sourceSuite = path.resolve(extensionRoot, '__tests__/e2e-real/suite/run');
const extensionTestsPath = fs.existsSync(compiledSuite) ? compiledSuite : sourceSuite;

const sessionFile = process.env.AEGIS_WORKSPACE_OUTPUT
  || path.resolve(extensionRoot, '__tests__/e2e-real/.workspace-session.json');

function runHelper(args = []) {
  const scriptPath = path.resolve(extensionRoot, 'scripts/prepare-real-workspace.ts');
  const execArgs = ['-r', 'ts-node/register', scriptPath, ...args];
  const result = spawnSync(process.execPath, execArgs, {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runPrepareHelper(additionalArgs = []) {
  const args = ['--output', sessionFile, ...additionalArgs];
  const result = runHelper(args);
  if ((result.status ?? 0) !== 0) {
    throw new Error(`prepare-real-workspace helper exited with code ${result.status}`);
  }
}

function ensureWorkspacePrepared() {
  if (!fs.existsSync(sessionFile)) {
    console.log('[real-e2e] session file missing; preparing workspace');
    runPrepareHelper();
  }
  const raw = fs.readFileSync(sessionFile, 'utf8');
  const session = JSON.parse(raw);
  if (!session.workspace_id) {
    throw new Error('Workspace session missing workspace_id');
  }
  process.env.AEGIS_WORKSPACE_ID = session.workspace_id;
  if (session.project_id && !process.env.AEGIS_PROJECT_ID) {
    process.env.AEGIS_PROJECT_ID = session.project_id;
  }
  if (session.namespace && !process.env.AEGIS_PLATFORM_NAMESPACE) {
    process.env.AEGIS_PLATFORM_NAMESPACE = session.namespace;
  }
  if (session.ca_file) {
    process.env.AEGIS_CA_PEM = session.ca_file;
  }
  return session;
}

function scheduleCleanup(session) {
  if ((scheduleCleanup).alreadyScheduled) {
    return;
  }
  (scheduleCleanup).alreadyScheduled = true;
  const cleanupArgs = ['--mode', 'cleanup', '--session-file', sessionFile];

  const invokeCleanup = () => {
    try {
      const result = runHelper(cleanupArgs);
      if ((result.status ?? 0) !== 0) {
        console.warn('[real-e2e] cleanup helper exited with code', result.status);
      } else {
        console.log('[real-e2e] cleanup helper completed for workspace', session.workspace_id);
      }
    } catch (err) {
      console.warn('[real-e2e] cleanup helper threw', err);
    }
  };

  process.on('exit', invokeCleanup);
  process.on('SIGINT', () => {
    invokeCleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    invokeCleanup();
    process.exit(1);
  });
}

function printLogTail(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const count = Number.parseInt(process.env.AEGIS_E2E_LOG_TAIL || '2000', 10);
    const tail = lines.slice(-count).join('\n');
    console.log(`---- ${label} (last ${Math.min(lines.length, count)} lines) ----`);
    console.log(tail);
    console.log(`---- end ${label} ----`);
  } catch (err) {
    console.warn(`[real-e2e] failed to read ${label}:`, err);
  }
}

async function main() {
  const session = ensureWorkspacePrepared();
  scheduleCleanup(session);

  const userDataDir = path.resolve(extensionRoot, '__tests__/.user-data-real');
  const logsDir = path.resolve(extensionRoot, '__tests__/logs-real');
  fs.mkdirSync(logsDir, { recursive: true });

  process.env.MOCHA_REPORTER = process.env.MOCHA_REPORTER || 'mocha-junit-reporter';
  process.env.MOCHA_FILE = process.env.MOCHA_FILE
    || path.resolve(extensionRoot, '__tests__/test-results/junit/mocha-e2e-real-results.xml');

  const launchArgs = [
    `--user-data-dir=${userDataDir}`,
    `--logsPath=${logsDir}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--enable-proposed-api=aegis.aegis-remote',
  ];

  try {
    await runTests({
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath,
      launchArgs,
    });
  } catch (err) {
    console.error(err);
    if (process.env.AEGIS_E2E_DEBUG === '1') {
      const renderLog = path.resolve(logsDir, 'window1/renderer.log');
      const mainLog = path.resolve(logsDir, 'main.log');
      const networkLog = path.resolve(logsDir, 'window1/network.log');
      printLogTail(renderLog, 'renderer.log');
      printLogTail(mainLog, 'main.log');
      printLogTail(networkLog, 'network.log');
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
