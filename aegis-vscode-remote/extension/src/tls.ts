/**
 * TLS Certificate Authority Utilities
 *
 * IMPORTANT: Never pass a custom CA directly to TLS clients (undici, grpc-js).
 * These libraries REPLACE system root CAs when you provide a custom CA.
 * Always use the utilities in this module to combine system + custom CAs.
 *
 * @see /docs/infrastructure-reference.md for full documentation
 */

import * as tls from 'tls';
import { promises as fs } from 'fs';
import { out } from './ui';

/**
 * Extracts individual PEM certificates from a file that may contain multiple certs.
 */
function extractPemCertificates(pemContent: string): string[] {
  const pemRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  return pemContent.match(pemRegex) || [];
}

/**
 * Combines system root CAs with custom CA certificates.
 *
 * This is REQUIRED because both undici and @grpc/grpc-js REPLACE system CAs
 * when you provide a custom CA. Without combining, connections to services
 * using public CAs (Cloudflare, Let's Encrypt, etc.) will fail with
 * "unable to get local issuer certificate".
 *
 * @param customCAPem - Custom CA certificate(s) in PEM format
 * @returns Array of all CA certificates (system + custom)
 */
export function getCombinedCAsArray(customCAPem: string | Buffer): string[] {
  const systemCAs = tls.rootCertificates;
  const customCAString = typeof customCAPem === 'string' ? customCAPem : customCAPem.toString('utf8');
  const customCerts = extractPemCertificates(customCAString);

  out.appendLine(`[tls] combining ${customCerts.length} custom CA cert(s) with ${systemCAs.length} system CAs`);

  return [...systemCAs, ...customCerts];
}

/**
 * Combines system root CAs with custom CA certificates into a single Buffer.
 * Use this for @grpc/grpc-js which expects a Buffer.
 *
 * @param customCAPem - Custom CA certificate(s) in PEM format
 * @returns Buffer containing all CA certificates
 */
export function getCombinedCAsBuffer(customCAPem: string | Buffer): Buffer {
  const allCAs = getCombinedCAsArray(customCAPem);
  return Buffer.from(allCAs.join('\n'), 'utf8');
}

/**
 * Loads and combines CAs from a file path.
 * Returns undefined if the file doesn't exist or is empty (uses system CAs only).
 *
 * @param caPath - Path to custom CA file
 * @returns Combined CAs as array, or undefined to use system CAs only
 */
export async function loadCombinedCAsArray(caPath: string | undefined): Promise<string[] | undefined> {
  if (!caPath) {
    return undefined;
  }

  try {
    const customCA = await fs.readFile(caPath);
    if (customCA.length === 0) {
      out.appendLine(`[tls] WARNING: CA file at ${caPath} is empty, using system CAs only`);
      return undefined;
    }
    return getCombinedCAsArray(customCA);
  } catch (err) {
    out.appendLine(`[tls] failed to read CA file at ${caPath}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Loads and combines CAs from a file path into a Buffer.
 * Returns undefined if the file doesn't exist or is empty (uses system CAs only).
 *
 * @param caPath - Path to custom CA file
 * @returns Combined CAs as Buffer, or undefined to use system CAs only
 */
export async function loadCombinedCAsBuffer(caPath: string | undefined): Promise<Buffer | undefined> {
  if (!caPath) {
    return undefined;
  }

  try {
    const customCA = await fs.readFile(caPath);
    if (customCA.length === 0) {
      out.appendLine(`[tls] WARNING: CA file at ${caPath} is empty, using system CAs only`);
      return undefined;
    }
    return getCombinedCAsBuffer(customCA);
  } catch (err) {
    out.appendLine(`[tls] failed to read CA file at ${caPath}: ${String(err)}`);
    return undefined;
  }
}
