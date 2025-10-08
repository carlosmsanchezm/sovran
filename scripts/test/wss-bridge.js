const { createServer } = require('https');
const { readFileSync } = require('fs');
const httpProxy = require('http-proxy');
const path = require('node:path');

async function startBridge(opts = {}) {
  const targetPort = opts.targetPort ?? 7001;
  const certPath = opts.certPath ?? path.resolve('aegis-vscode-remote/proxy/cert.crt');
  const keyPath = opts.keyPath ?? path.resolve('aegis-vscode-remote/proxy/cert.key');
  const listenPort = opts.listenPort ?? 7443;

  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);

  const proxy = httpProxy.createProxyServer({
    target: `https://127.0.0.1:${targetPort}`,
    ws: true,
    secure: false,
    changeOrigin: true
  });

  const server = createServer({ cert, key }, (req, res) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }
    if (req.url.startsWith('/healthz')) {
      res.writeHead(200).end('ok');
      return;
    }
    req.url = '/tunnel';
    proxy.web(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    req.url = '/tunnel';
    proxy.ws(req, socket, head);
  });

  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  const address = server.address();
  console.log(`[bridge] listening wss://127.0.0.1:${address.port} -> https://127.0.0.1:${targetPort}/tunnel`);
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

module.exports = { startBridge };

if (require.main === module) {
  startBridge().catch((err) => {
    console.error('[bridge] failed', err);
    process.exitCode = 1;
  });
}
