const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionRoot = path.resolve(__dirname, '../../');
  const extensionDevelopmentPath = extensionRoot; // use real compiled extension

  const compiledSuite = path.resolve(extensionRoot, '__tests__/e2e-real/out/suite/run.js');
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

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
