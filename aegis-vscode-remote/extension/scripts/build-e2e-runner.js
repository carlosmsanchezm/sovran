const ts = require('typescript');
const path = require('path');
const fs = require('fs');

const configPath = path.resolve(__dirname, '../__tests__/e2e/tsconfig.json');
const readConfig = ts.readConfigFile(configPath, ts.sys.readFile);
if (readConfig.error) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext([readConfig.error], {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
    getCanonicalFileName: (fileName) => fileName,
  }));
}

const parseResult = ts.parseJsonConfigFileContent(
  readConfig.config,
  ts.sys,
  path.dirname(configPath)
);

const program = ts.createProgram(parseResult.fileNames, parseResult.options);
const emitResult = program.emit();

const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
if (diagnostics.length > 0) {
  const formatHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  };
  throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
}

const bundleDir = path.resolve(__dirname, '../out-e2e');
const suiteDir = path.join(bundleDir, 'suite');
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.main = './extension.js';
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(suiteDir, { recursive: true });
fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify(pkg, null, 2));
const stubs = [
  { source: '../src/__tests__/stubs/ui.e2e.stub.ts', target: 'ui.js' },
  { source: '../src/__tests__/stubs/platform.e2e.stub.ts', target: 'platform.js' },
  { source: '../src/__tests__/stubs/config.e2e.stub.ts', target: 'config.js' },
  { source: '../src/__tests__/stubs/diagnostics.stub.ts', target: 'diagnostics.js' }
];
for (const stub of stubs) {
  const sourcePath = path.resolve(__dirname, stub.source);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    }
  });
  const targetPath = path.join(bundleDir, stub.target);
  fs.writeFileSync(targetPath, transpiled.outputText);
}

