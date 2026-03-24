import { out } from './ui';

// ---------------------------------------------------------------------------
// Error categorization (Task #21)
// ---------------------------------------------------------------------------

export type ErrorCategory = 'auth' | 'network' | 'proxy' | 'workspace' | 'unknown';

export interface CategorizedError {
  message: string;
  category: ErrorCategory;
}

/**
 * Categorise a connection-related error into one of a handful of buckets so
 * the user sees a human-readable message and the UI can take appropriate
 * remedial action (e.g. prompt re-login for auth errors).
 */
export function categorizeConnectionError(err: unknown): CategorizedError {
  const msg = err instanceof Error ? err.message : String(err);

  // --- Network layer ---
  if (msg.includes('ECONNREFUSED') || msg.includes('EHOSTUNREACH')) {
    return { message: 'Cannot reach the Aegis proxy. Check your network connection and proxy URL.', category: 'network' };
  }
  if (msg.includes('ENOTFOUND')) {
    return { message: 'DNS resolution failed. Verify the proxy hostname is correct.', category: 'network' };
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
    return { message: 'Connection timed out. The proxy may be temporarily unavailable.', category: 'network' };
  }
  if (msg.includes('certificate') || msg.includes('TLS') || msg.includes('SSL') || msg.includes('ERR_TLS')) {
    if (msg.includes('CERT_ALTNAME_INVALID') || msg.includes('hostname') || msg.includes('altnames')) {
      return { message: `TLS hostname mismatch: the server certificate doesn't match the URL. ${msg}`, category: 'network' };
    }
    if (msg.includes('CERT_HAS_EXPIRED') || msg.includes('expired')) {
      return { message: `TLS certificate has expired. Check certificate renewal. ${msg}`, category: 'network' };
    }
    if (msg.includes('UNABLE_TO_VERIFY') || msg.includes('self signed') || msg.includes('unable to get issuer')) {
      return { message: `TLS CA trust error: certificate not trusted. Check aegisRemote.security.caPath. ${msg}`, category: 'network' };
    }
    return { message: `TLS error: ${msg}`, category: 'network' };
  }

  // --- Authentication / authorization ---
  if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('token')) {
    return { message: 'Authentication failed. Try signing out and back in.', category: 'auth' };
  }
  if (msg.includes('403') || msg.includes('Forbidden')) {
    return { message: 'Access denied. You may not have permission to access this workspace.', category: 'auth' };
  }

  // --- Workspace / pod ---
  if (msg.includes('1006') || msg.includes('abnormal')) {
    return { message: 'Workspace connection lost unexpectedly. The workspace pod may have been terminated.', category: 'workspace' };
  }

  // --- Fallback ---
  return { message: `Connection error: ${msg}`, category: 'unknown' };
}

// ---------------------------------------------------------------------------
// WebSocket close-code helpers (Task #23)
// ---------------------------------------------------------------------------

export interface CloseInfo {
  userMessage: string;
  category: ErrorCategory;
  isAbnormal: boolean;
}

/**
 * Translate a WebSocket close code into a user-facing message and category.
 */
export function categorizeCloseCode(code: number | undefined, reason?: string): CloseInfo {
  if (code === 1000) {
    return {
      userMessage: 'Workspace session ended normally.',
      category: 'workspace',
      isAbnormal: false,
    };
  }
  if (code === 1006 || code === undefined) {
    return {
      userMessage: 'Workspace disconnected. The workspace pod may have been stopped or restarted.',
      category: 'workspace',
      isAbnormal: true,
    };
  }
  if (code === 1001) {
    return {
      userMessage: 'Workspace is going away (server shutting down).',
      category: 'workspace',
      isAbnormal: true,
    };
  }
  if (code === 1008 || code === 1003) {
    return {
      userMessage: `Workspace connection was rejected by the proxy (code ${code}).`,
      category: 'proxy',
      isAbnormal: true,
    };
  }
  const detail = reason ? ` Reason: ${reason}` : '';
  return {
    userMessage: `Workspace disconnected (code ${code}).${detail}`,
    category: 'unknown',
    isAbnormal: true,
  };
}

// ---------------------------------------------------------------------------
// Exponential-backoff retry utility (Task #22)
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
}

/**
 * Execute `fn` with exponential-backoff retry.  Suitable for token refreshes,
 * gRPC calls, and similar idempotent operations.  **Not** suitable for
 * WebSocket opens (those should fail fast and let the user retry).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, label = 'operation' } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        out.appendLine(`[retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
