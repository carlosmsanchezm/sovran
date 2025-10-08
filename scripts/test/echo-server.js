const net = require('node:net');

function startEcho(port = 11111) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

module.exports = { startEcho };

if (require.main === module) {
  startEcho().then(() => console.log('[echo] listening on 11111')).catch((err) => {
    console.error('[echo] failed', err);
    process.exitCode = 1;
  });
}
