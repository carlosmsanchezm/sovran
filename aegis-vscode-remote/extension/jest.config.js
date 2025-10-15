/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }]
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__tests__/stubs/vscode.stub.ts',
    '^\\./ui$': '<rootDir>/src/__tests__/stubs/ui.stub.ts',
    '^\\./platform$': '<rootDir>/src/__tests__/stubs/platform.stub.ts',
    '^\\./config$': '<rootDir>/src/__tests__/stubs/config.stub.ts',
    '^\\./diagnostics$': '<rootDir>/src/__tests__/stubs/diagnostics.stub.ts'
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/jest.setup.ts'],
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/vscode.proposed.*.d.ts',
    '!src/**/stubs/**'
  ],
  coverageDirectory: '<rootDir>/coverage',
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: '<rootDir>/test-results/junit',
      outputName: 'jest-results.xml',
      suiteName: 'jest-tests',
      addFileAttribute: true
    }]
  ],
  coverageReporters: ['text', 'lcov', 'json-summary', 'json'],
  coverageThreshold: {
    global: {
      lines: 80,
      statements: 80,
      branches: 70,
      functions: 80
    }
  },
  testTimeout: 30000
};
