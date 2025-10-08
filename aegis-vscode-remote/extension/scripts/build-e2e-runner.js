const ts = require('typescript');
const path = require('path');

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
