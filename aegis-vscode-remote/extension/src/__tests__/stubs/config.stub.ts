export type LogLevel = 'info' | 'debug' | 'trace';

type Security = {
  rejectUnauthorized: boolean;
  mtlsSource: 'platform' | 'system';
  caPath?: string;
};

type Settings = {
  platform: {
    grpcEndpoint: string;
    namespace: string;
    authScope: string;
    projectId: string;
  };
  auth: {
    authority: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    prompt?: string;
  };
  defaultWorkspaceId?: string;
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  security: Security;
  logLevel: LogLevel;
  isSecureMode: boolean;
};

const baseSettings = (): Settings => ({
  platform: {
    grpcEndpoint: 'platform.localtest.me:443',
    namespace: 'default',
    authScope: 'aegis-platform',
    projectId: 'p-test',
  },
  auth: {
    authority: 'https://keycloak.localtest.me/realms/aegis',
    clientId: 'vscode-extension',
    redirectUri: 'vscode://aegis.aegis-remote/auth',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    prompt: '',
  },
  defaultWorkspaceId: '',
  heartbeatIntervalMs: 15_000,
  idleTimeoutMs: 45_000,
  security: {
    rejectUnauthorized: true,
    mtlsSource: 'platform',
    caPath: '',
  },
  logLevel: 'info',
  isSecureMode: false,
});

const STORE_KEY = '__aegis_config_stub_store__';

type Store = { settings: Settings };

function getStore(): Store {
  const globalAny = globalThis as Record<string, unknown>;
  if (!globalAny[STORE_KEY]) {
    globalAny[STORE_KEY] = { settings: baseSettings() } satisfies Store;
  }
  return globalAny[STORE_KEY] as Store;
}

export function getSettings(): Settings {
  return getStore().settings;
}

export function onDidChangeSettings(_listener: () => void) {
  return { dispose() {} };
}

export function __setSettings(overrides: Partial<Settings>) {
  const base = baseSettings();
  getStore().settings = {
    ...base,
    ...overrides,
    platform: { ...base.platform, ...(overrides.platform ?? {}) },
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
    security: { ...base.security, ...(overrides.security ?? {}) },
  };
}

export function __resetSettings() {
  getStore().settings = baseSettings();
}
