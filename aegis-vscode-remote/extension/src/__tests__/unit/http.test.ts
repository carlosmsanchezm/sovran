import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { configureHttpSecurity, disposeHttpSecurity, getHttpDispatcher } from '../../http';

jest.mock('../../ui', () => ({
  out: {
    appendLine: jest.fn(),
  },
}));

describe('http security configuration', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    await disposeHttpSecurity();
  });

  test('installs custom dispatcher when CA bundle provided', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-http-test-'));
    const caPath = path.join(tempDir, 'ca.pem');
    await fs.writeFile(caPath, 'dummy-ca');

    await configureHttpSecurity({
      rejectUnauthorized: true,
      mtlsSource: 'platform',
      caPath,
    });

    expect(getHttpDispatcher()).toBeDefined();
  });

  test('disables TLS verification when rejectUnauthorized is false', async () => {
    await configureHttpSecurity({
      rejectUnauthorized: false,
      mtlsSource: 'platform',
    });

    expect(getHttpDispatcher()).toBeDefined();
  });

  test('uses default dispatcher when no overrides apply', async () => {
    await configureHttpSecurity({
      rejectUnauthorized: true,
      mtlsSource: 'platform',
    });

    expect(getHttpDispatcher()).toBeUndefined();
  });
});
