import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as tls from 'tls';
import {
  getCombinedCAsArray,
  getCombinedCAsBuffer,
  loadCombinedCAsArray,
  loadCombinedCAsBuffer,
} from '../../tls';

const CERT_ONE = '-----BEGIN CERTIFICATE-----\nCERT_ONE\n-----END CERTIFICATE-----';
const CERT_TWO = '-----BEGIN CERTIFICATE-----\nCERT_TWO\n-----END CERTIFICATE-----';

describe('tls CA utilities', () => {
  test('getCombinedCAsArray appends extracted PEM certs', () => {
    const combined = getCombinedCAsArray(Buffer.from(`${CERT_ONE}\n${CERT_TWO}`, 'utf8'));
    expect(combined.slice(0, tls.rootCertificates.length)).toEqual(tls.rootCertificates);
    expect(combined.slice(-2)).toEqual([CERT_ONE, CERT_TWO]);
  });

  test('getCombinedCAsArray returns system CAs when no PEM blocks exist', () => {
    expect(getCombinedCAsArray('not-a-cert')).toEqual(tls.rootCertificates);
  });

  test('getCombinedCAsBuffer returns a concatenated PEM buffer', () => {
    const combined = getCombinedCAsBuffer(CERT_ONE).toString('utf8');
    expect(combined).toContain(CERT_ONE);
  });

  test('loadCombinedCAsArray returns undefined when no path is provided', async () => {
    await expect(loadCombinedCAsArray(undefined)).resolves.toBeUndefined();
  });

  test('loadCombinedCAsArray returns undefined when the file does not exist', async () => {
    await expect(loadCombinedCAsArray('/definitely/does/not/exist/ca.pem')).resolves.toBeUndefined();
  });

  test('loadCombinedCAsArray returns undefined when the file is empty', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-tls-test-'));
    const caPath = path.join(tempDir, 'empty-ca.pem');
    await fs.writeFile(caPath, '');
    await expect(loadCombinedCAsArray(caPath)).resolves.toBeUndefined();
  });

  test('loadCombinedCAsArray returns combined CAs when the file has content', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-tls-test-'));
    const caPath = path.join(tempDir, 'ca.pem');
    await fs.writeFile(caPath, CERT_ONE);
    const combined = await loadCombinedCAsArray(caPath);
    expect(combined).toBeDefined();
    expect(combined!.slice(-1)).toEqual([CERT_ONE]);
  });

  test('loadCombinedCAsBuffer returns combined buffer when the file has content', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-tls-test-'));
    const caPath = path.join(tempDir, 'ca.pem');
    await fs.writeFile(caPath, CERT_ONE);
    const combined = await loadCombinedCAsBuffer(caPath);
    expect(combined?.toString('utf8')).toContain(CERT_ONE);
  });
});

