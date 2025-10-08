import { EventEmitter } from 'vscode';

type StatusEvent = { text: string; url?: string };

export const out = {
  appendLine: (msg: string) => {
    console.log('[e2e-out]', msg);
  },
};

const statusEmitter = new EventEmitter<StatusEvent>();

export const status = {
  set: (text: string, url?: string) => {
    console.log('[e2e-status]', text, url ?? '');
    statusEmitter.fire({ text, url });
  },
  onDidChange: statusEmitter.event,
};

export class WorkspacesProvider {
  constructor(_ctx: unknown) {}
  refresh() {}
  dispose() {}
}
