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

  test('connect via command and URI handler', async () => {
    const extension = vscode.extensions.getExtension('aegis.aegis-remote');
    assert.ok(extension, 'extension should be available');
    if (!extension!.isActive) {
      await extension!.activate();
    }

    const bundleDir = process.env.VSCODE_EXTENSION_TEST_BUNDLE_DIR;
    assert.ok(bundleDir, 'bundle directory not provided');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { status } = require(path.join(bundleDir!, 'ui.js'));

    let connected = false;
    let disconnected = false;
    const statusDisposable = status.onDidChange?.((event: any) => {
      const text = String(event?.text ?? '');
      if (text.includes('Connected')) {
        connected = true;
      }
      if (text.includes('Disconnected')) {
        disconnected = true;
      }
    });

    const originalShowInputBox = vscode.window.showInputBox;
    const prompts = ['dev@example.com', 'token-e2e'];
    (vscode.window.showInputBox as any) = async () => prompts.shift() ?? 'token-e2e';

    try {
      await vscode.commands.executeCommand('aegis.connect', 'w-e2e');
      await waitFor(() => connected, 15000);

      const uri = vscode.Uri.parse('vscode://aegis.aegis-remote/aegis+w-e2e');
      await vscode.env.openExternal(uri);

      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('aegis.disconnect');

      await waitFor(() => disconnected, 10000);
    } finally {
      (vscode.window.showInputBox as any) = originalShowInputBox;
      statusDisposable?.dispose?.();
    }
  });
});
