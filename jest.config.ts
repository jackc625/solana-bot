import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';

// Read tsconfig paths
const tsconfig = {
  compilerOptions: {
    paths: {
      '@/*': ['src/*'],
      '@features/*': ['src/features/*'],
      '@core/*': ['src/core/*'],
      '@utils/*': ['src/utils/*'],
      '@types/*': ['src/types/*'],
      '@config/*': ['src/config/*'],
    },
  },
};

const config: Config = {
  testEnvironment: 'node',
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          target: 'ES2022',
          module: 'ESNext',
        },
      },
    ],
  },
  moduleNameMapper: {
    ...(tsconfig.compilerOptions?.paths
      ? pathsToModuleNameMapper(tsconfig.compilerOptions.paths, { prefix: '<rootDir>/' })
      : {}),
    // Fix ESM import paths that end with .js in TS sources
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  roots: ['<rootDir>/src', '<rootDir>/test', '<rootDir>/tests'],
  testMatch: ['**/test/**/*.test.ts', '**/tests/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/bot.ts', // Main entry point - tested via integration
    '!src/**/__tests__/**',
    '!src/**/index.ts', // Re-export files
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'html', 'lcov'],
  testTimeout: 10000,
  clearMocks: true,
  restoreMocks: true,
};

export default config;
