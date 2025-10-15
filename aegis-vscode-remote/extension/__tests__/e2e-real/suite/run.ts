import * as path from 'path';
import * as fs from 'fs';
import glob from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const reporter = process.env.MOCHA_REPORTER || 'mocha-junit-reporter';
  const mochaFile = process.env.MOCHA_FILE
    || path.resolve(__dirname, '../../test-results/junit/mocha-e2e-real-results.xml');

  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    reporter,
    reporterOptions: {
      mochaFile,
      suiteTitleSeparatedBy: ' / '
    }
  });

  const testsRoot = __dirname;
  const files = await new Promise<string[]>((resolve, reject) => {
    glob('**/*.js', { cwd: testsRoot }, (err: Error | null, matches: string[]) => {
      if (err) {
        reject(err);
      } else {
        resolve(matches);
      }
    });
  });

  // Ensure directory for JUnit output exists
  const reportDir = path.dirname(mochaFile);
  fs.mkdirSync(reportDir, { recursive: true });

  files
    .filter((file) => !file.endsWith(`${path.sep}run.js`))
    .forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

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
