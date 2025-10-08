import { jest } from '@jest/globals';

export const out = {
  appendLine: jest.fn(),
  show: jest.fn(),
};

export const status = {
  set: jest.fn(),
};

export class WorkspacesProvider {
  constructor(_ctx: unknown) {}
  refresh() {}
  dispose() {}
}
