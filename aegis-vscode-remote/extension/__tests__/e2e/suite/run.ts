import * as path from 'path';
import { promises as fs } from 'fs';
import Mocha from 'mocha';

async function collectTestFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const entryPath = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'run' || entry.name === 'test-results') continue;
      const nested = await collectTestFiles(entryPath);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(entryPath);
    }
  }
  return results;
}

export async function run(): Promise<void> {
  const reporter = process.env.MOCHA_REPORTER || 'mocha-junit-reporter';
  const mochaFile = process.env.MOCHA_FILE
    || path.resolve(__dirname, '../../test-results/junit/mocha-e2e-results.xml');

  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    reporter,
    reporterOptions: {
      mochaFile,
      suiteTitleSeparatedBy: ' / ',
    },
  });

  const testsRoot = __dirname;
  const files = await collectTestFiles(testsRoot);

  // Ensure output directory exists for reporters that write to disk.
  const reportDir = path.dirname(mochaFile);
  await fs.mkdir(reportDir, { recursive: true }).catch(() => undefined);
  files
    .filter((file) => !file.endsWith(`${path.sep}run.js`))
    .forEach((file) => mocha.addFile(file));

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} failing tests`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
