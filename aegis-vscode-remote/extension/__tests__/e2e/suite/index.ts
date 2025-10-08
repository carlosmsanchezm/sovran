import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Aegis E2E', function () {
  this.timeout(60000);

  test('activates and registers commands', async () => {
    const extension = vscode.extensions.getExtension('aegis.aegis-remote');
    assert.ok(extension, 'extension should be available');
    if (!extension!.isActive) {
      await extension!.activate();
    }

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('aegis.connect'), 'aegis.connect command registered');
    assert.ok(commands.includes('aegis.disconnect'), 'aegis.disconnect command registered');
  });
});
