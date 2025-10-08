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
    const { status } = require(path.join(bundleDir!, 'ui.js'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AegisResolver } = require(path.join(bundleDir!, 'resolver.js'));

    let connected = false;
    let disconnected = false;
    let receivedEcho = false;
    const statusDisposable = status.onDidChange?.((event: any) => {
      const text = String(event?.text ?? '');
      if (text.includes('Connected')) {
        connected = true;
      }
      if (text.includes('Disconnected')) {
        disconnected = true;
      }
    });

    try {
      const result = await AegisResolver.resolve('aegis+w-e2e', { resolveAttempt: 1 } as any);
      const transport = await result.opener();
      await waitFor(() => connected, 15000);
      transport.onDidReceiveMessage(() => {
        receivedEcho = true;
      });
      transport.send(new Uint8Array([1, 2, 3]));
      await waitFor(() => receivedEcho, 5000);
      transport.end();
      await waitFor(() => disconnected, 10000);
    } finally {
      statusDisposable?.dispose?.();
    }
  });
});
