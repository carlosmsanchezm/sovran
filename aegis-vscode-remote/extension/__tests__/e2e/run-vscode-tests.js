const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
const compiledTestsPath = path.resolve(extensionDevelopmentPath, 'out-e2e/suite/run.js');
  const sourceTestsPath = path.resolve(__dirname, './suite/run');
  const extensionTestsPath = fs.existsSync(compiledTestsPath) ? compiledTestsPath : sourceTestsPath;
  const launchArgs = [
    '--disable-extensions',
    '--user-data-dir=' + path.join(__dirname, '.user-data'),
    '--skip-welcome',
    '--skip-release-notes',
    '--enable-proposed-api=aegis.aegis-remote',
  ];
  
  process.env.AEGIS_TEST_PROXY_URL = process.env.AEGIS_TEST_PROXY_URL || 'https://127.0.0.1:7443';
  process.env.VSCODE_EXTENSION_TEST_BUNDLE_DIR = path.join(extensionDevelopmentPath, 'out-e2e');
  process.env.MOCHA_REPORTER = process.env.MOCHA_REPORTER || 'mocha-junit-reporter';
  process.env.MOCHA_FILE = process.env.MOCHA_FILE
    || path.resolve(extensionDevelopmentPath, '__tests__/test-results/junit/mocha-e2e-results.xml');

  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
