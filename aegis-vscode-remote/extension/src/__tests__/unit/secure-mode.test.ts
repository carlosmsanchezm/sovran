import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';

let secureMode: typeof import('../../secure-mode');

describe('secure-mode', () => {
  const originalEnv = process.env.AEGIS_SECURE_LAUNCH;

  beforeEach(async () => {
    delete process.env.AEGIS_SECURE_LAUNCH;
    jest.resetModules();
    secureMode = await import('../../secure-mode');
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AEGIS_SECURE_LAUNCH = originalEnv;
    } else {
      delete process.env.AEGIS_SECURE_LAUNCH;
    }
  });

  describe('isSecureMode', () => {
    test('returns false when env var is unset', () => {
      expect(secureMode.isSecureMode()).toBe(false);
    });

    test('returns true when AEGIS_SECURE_LAUNCH=1', () => {
      process.env.AEGIS_SECURE_LAUNCH = '1';
      expect(secureMode.isSecureMode()).toBe(true);
    });

    test('returns false for other values', () => {
      process.env.AEGIS_SECURE_LAUNCH = 'true';
      expect(secureMode.isSecureMode()).toBe(false);

      process.env.AEGIS_SECURE_LAUNCH = '0';
      expect(secureMode.isSecureMode()).toBe(false);
    });
  });

  describe('redactUrl', () => {
    test('strips query params and fragment', () => {
      const result = secureMode.redactUrl('https://keycloak.example.com/auth?client_id=foo&state=bar#frag');
      expect(result).toBe('https://keycloak.example.com/auth');
      expect(result).not.toContain('client_id');
      expect(result).not.toContain('#frag');
    });

    test('redacts JWT-like strings', () => {
      const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig';
      const result = secureMode.redactUrl(`https://example.com/path/${jwt}`);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('eyJhbGci');
    });

    test('handles invalid URLs gracefully', () => {
      const result = secureMode.redactUrl('not-a-url?secret=value');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('secret=value');
    });

    test('passes through clean URLs unchanged', () => {
      const result = secureMode.redactUrl('https://proxy.example.com/proxy/w-123');
      expect(result).toBe('https://proxy.example.com/proxy/w-123');
    });
  });

  describe('redactSettings', () => {
    const settings = {
      platform: {
        grpcEndpoint: 'platform.example.com:443',
        grpcServerName: 'platform.example.com',
        namespace: 'default',
        authScope: 'aegis-platform',
        projectId: 'p-test',
      },
      auth: {
        authority: 'https://keycloak.example.com/realms/aegis',
        clientId: 'vscode-extension',
        redirectUri: 'vscode://aegis.aegis-remote/auth',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      },
      heartbeatIntervalMs: 15000,
      idleTimeoutMs: 45000,
      security: {
        rejectUnauthorized: true,
        mtlsSource: 'platform' as const,
        caPath: '/secret/path/ca.pem',
      },
      logLevel: 'info' as const,
      isSecureMode: true,
    };

    test('masks authority to hostname only', () => {
      const redacted = secureMode.redactSettings(settings as any);
      expect((redacted.auth as any).authority).toBe('keycloak.example.com');
    });

    test('replaces scopes with count', () => {
      const redacted = secureMode.redactSettings(settings as any);
      expect((redacted.auth as any).scopeCount).toBe(4);
      expect((redacted.auth as any).scopes).toBeUndefined();
    });

    test('omits caPath', () => {
      const redacted = secureMode.redactSettings(settings as any);
      expect((redacted.security as any).caPath).toBeUndefined();
    });

    test('preserves non-sensitive fields', () => {
      const redacted = secureMode.redactSettings(settings as any);
      expect((redacted.platform as any).grpcEndpoint).toBe('platform.example.com:443');
      expect(redacted.logLevel).toBe('info');
    });
  });

  describe('clampLogLevel', () => {
    test('passes through in normal mode', () => {
      delete process.env.AEGIS_SECURE_LAUNCH;
      expect(secureMode.clampLogLevel('trace')).toBe('trace');
      expect(secureMode.clampLogLevel('debug')).toBe('debug');
      expect(secureMode.clampLogLevel('info')).toBe('info');
    });

    test('clamps to info in secure mode', () => {
      process.env.AEGIS_SECURE_LAUNCH = '1';
      expect(secureMode.clampLogLevel('trace')).toBe('info');
      expect(secureMode.clampLogLevel('debug')).toBe('info');
      expect(secureMode.clampLogLevel('info')).toBe('info');
    });
  });

  describe('SECURE_MODE_SCOPES', () => {
    test('does not include offline_access', () => {
      expect(secureMode.SECURE_MODE_SCOPES).not.toContain('offline_access');
      expect(secureMode.SECURE_MODE_SCOPES).toContain('openid');
      expect(secureMode.SECURE_MODE_SCOPES).toContain('profile');
      expect(secureMode.SECURE_MODE_SCOPES).toContain('email');
    });
  });
});
