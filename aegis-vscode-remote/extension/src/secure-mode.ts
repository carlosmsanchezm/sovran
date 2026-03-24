import type { AegisSettings, LogLevel } from './config';

/**
 * Returns true when the extension is running inside the Secure Launcher
 * (RAM-disk + FDE-verified environment for CUI handling).
 *
 * Activated by setting AEGIS_SECURE_LAUNCH=1 before starting VS Code.
 */
export function isSecureMode(): boolean {
  return process.env.AEGIS_SECURE_LAUNCH === '1';
}

/** Scopes requested in secure mode — no offline_access (no refresh tokens). */
export const SECURE_MODE_SCOPES = ['openid', 'profile', 'email'] as const;

const JWT_LIKE_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/**
 * Strip query parameters, fragment, and JWT-like strings from a URL so it can
 * be safely logged without leaking tokens or PII.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(JWT_LIKE_RE, '[REDACTED]');
  } catch {
    // Not a valid URL — still redact JWT-like strings
    return url.replace(/\?[^\s]*/g, '?[REDACTED]').replace(JWT_LIKE_RE, '[REDACTED]');
  }
}

/**
 * Return a sanitised copy of the extension settings suitable for logging.
 * Masks auth.authority to hostname-only, omits caPath, replaces scopes with a
 * count.
 */
export function redactSettings(settings: AegisSettings): Record<string, unknown> {
  let authorityHost: string;
  try {
    authorityHost = new URL(settings.auth.authority).hostname;
  } catch {
    authorityHost = '[invalid]';
  }

  return {
    platform: {
      grpcEndpoint: settings.platform.grpcEndpoint,
      namespace: settings.platform.namespace,
      projectId: settings.platform.projectId,
    },
    auth: {
      authority: authorityHost,
      clientId: settings.auth.clientId,
      scopeCount: settings.auth.scopes.length,
    },
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    security: {
      rejectUnauthorized: settings.security.rejectUnauthorized,
      mtlsSource: settings.security.mtlsSource,
    },
    logLevel: settings.logLevel,
    isSecureMode: settings.isSecureMode ?? false,
  };
}

/**
 * In secure mode, clamp the log level to 'info' to prevent debug/trace output
 * that could leak CUI content.  In normal mode, pass through unchanged.
 */
export function clampLogLevel(requested: LogLevel): LogLevel {
  if (isSecureMode()) {
    return 'info';
  }
  return requested;
}
