import { jest } from '@jest/globals';

export type Disposable = { dispose(): void };
export type Event<T> = (listener: (e: T) => any) => Disposable;

class Emitter<T> {
  private listeners: Array<(e: T) => any> = [];
  event: Event<T> = (listener) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      }
    };
  };

  fire(data: T) {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  dispose() {
    this.listeners = [];
  }
}

export const EventEmitter = Emitter;

type ShowInputBox = (options?: any) => Promise<string | undefined>;
const showInputBox = jest.fn(async (_options?: any) => undefined as string | undefined) as jest.MockedFunction<ShowInputBox>;

export const window = {
  createTreeView: jest.fn(() => ({ dispose: jest.fn() })),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    show: jest.fn(),
  })),
  createStatusBarItem: jest.fn(() => ({
    text: '',
    tooltip: undefined,
    show: jest.fn(),
  })),
  registerUriHandler: jest.fn(() => ({ dispose: jest.fn() })),
  showErrorMessage: jest.fn(),
  showInputBox,
};

export const workspace = {
  registerRemoteAuthorityResolver: jest.fn(() => ({ dispose: jest.fn() })),
  getConfiguration: jest.fn(() => ({ get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue) })),
};

export const commands = {
  executeCommand: jest.fn(),
  registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

type GetSession = (id: string, scopes: readonly string[], options?: any) => Promise<any>;
const getSession = jest.fn(async (_id: string, _scopes: readonly string[], _options?: any) => undefined) as jest.MockedFunction<GetSession>;

export const authentication = {
  registerAuthenticationProvider: jest.fn(() => ({ dispose: jest.fn() })),
  getSession,
};

export type AuthenticationSession = {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: readonly string[];
};

export class CancellationError extends Error {}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  public contextValue?: string;
  public description?: string;
  public iconPath?: ThemeIcon;
  public command?: { command: string; title: string; arguments?: unknown[] };

  constructor(public readonly label: string, public readonly collapsibleState: TreeItemCollapsibleState) {}
}

export type ExtensionContext = {
  subscriptions: { dispose?: () => void }[];
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

export const OutputChannel = class {
  appendLine = jest.fn();
  show = jest.fn();
};

export class ManagedResolvedAuthority {
  constructor(public opener: () => Promise<any>, _hello: string) {}
}

export const Uri = {
  parse: (value: string) => {
    const url = new URL(value);
    return {
      toString: () => value,
      path: url.pathname,
      scheme: url.protocol.replace(/:$/u, ''),
      authority: url.host,
      query: url.search.startsWith('?') ? url.search.slice(1) : '',
    };
  },
};

export const env = {
  openExternal: jest.fn(),
};
