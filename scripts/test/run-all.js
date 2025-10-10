const path = require('node:path');
const { startEcho } = require('./echo-server');
const { startBridge } = require('./wss-bridge');
const { startProxy } = require('./start-proxy');

async function main() {
  const { execa } = await import('execa');
  const echo = await startEcho(11111);
  let proxy;
  let bridge;
  try {
    bridge = await startBridge({ listenPort: 7443, targetPort: 7001 });

    const extCwd = path.resolve('aegis-vscode-remote/extension');
    const envWithProxy = { ...process.env, AEGIS_TEST_PROXY_URL: 'https://127.0.0.1:7443' };

    await execa('npm', ['run', 'test:unit'], { cwd: extCwd, stdio: 'inherit' });
    await execa('npm', ['run', 'test:integration'], { cwd: extCwd, stdio: 'inherit', env: envWithProxy });
    await execa('npm', ['run', 'build:test-e2e'], { cwd: extCwd, stdio: 'inherit' });
    await execa('npm', ['run', 'test:e2e'], { cwd: extCwd, stdio: 'inherit', env: envWithProxy });
  } finally {
    if (bridge) {
      await bridge.close();
    }
    if (proxy) {
      await proxy.stop();
    }
    await echo.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
