const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const launchArgs = [
    '--disable-extensions',
    '--user-data-dir=' + path.join(__dirname, '.user-data'),
    '--skip-welcome',
    '--skip-release-notes',
  ];

  process.env.AEGIS_TEST_PROXY_URL = process.env.AEGIS_TEST_PROXY_URL || 'https://127.0.0.1:7443';
  process.env.VSCODE_EXTENSION_TEST_BUNDLE_DIR = path.join(extensionDevelopmentPath, 'out-e2e');

  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
