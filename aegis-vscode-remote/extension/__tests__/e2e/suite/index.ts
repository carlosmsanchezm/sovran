import * as path from 'path';
import * as assert from 'assert';
import * as vscode from 'vscode';

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Aegis E2E', function () {
  this.timeout(60000);

  test('resolver connects over proxy and updates status', async () => {
    const extension = vscode.extensions.getExtension('aegis.aegis-remote');
    assert.ok(extension, 'extension should be available');
    if (!extension!.isActive) {
      await extension!.activate();
    }

    const bundleDir = process.env.VSCODE_EXTENSION_TEST_BUNDLE_DIR;
    assert.ok(bundleDir, 'bundle directory not provided');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AegisResolver } = require(path.join(bundleDir!, 'resolver.js'));

    try {
      const result = await AegisResolver.resolve('aegis+w-e2e', { resolveAttempt: 1 } as any);
      console.log('resolver result keys', Object.keys(result));
      console.log('resolver result', result);
      const transport = await result.opener();
      let receivedEcho = false;
      let closed = false;
      let ended = false;
      transport.onDidReceiveMessage(() => {
        receivedEcho = true;
      });
      transport.onDidClose(() => {
        closed = true;
      });
      transport.onDidEnd(() => {
        ended = true;
      });
      transport.send(new Uint8Array([1, 2, 3]));
      await waitFor(() => receivedEcho, 5000);
      transport.end();
      await waitFor(() => closed || ended, 10000);
    } finally {
    }
  });
});
