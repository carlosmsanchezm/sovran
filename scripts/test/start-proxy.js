const path = require('node:path');
const waitOn = require('wait-on');

async function startProxy() {
  const { execa } = await import('execa');
  const cwd = path.resolve('aegis-vscode-remote/proxy');
  const child = execa('npm', ['run', 'start:test'], { cwd, stdio: 'inherit' });

  await waitOn({ resources: ['https-get://127.0.0.1:7001/healthz'], strictSSL: false, timeout: 15000 });

  return {
    stop: async () => {
      try {
        child.kill('SIGTERM');
      } catch (err) {
        // ignore if already dead
      }
      try {
        await child;
      } catch (err) {
        if (err && err.isCanceled) {
          return;
        }
        if (err && err.signal === 'SIGTERM') {
          return;
        }
      }
    }
  };
}

module.exports = { startProxy };

if (require.main === module) {
  startProxy().catch((err) => {
    console.error('[proxy] failed to start', err);
    process.exitCode = 1;
  });
}
