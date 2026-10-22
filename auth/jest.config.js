module.exports = {
  moduleFileExtensions: ['ts', 'js', 'json'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^@crimfig/shared$': '<rootDir>/../shared/src/index.ts',
    '^@crimfig/database/schema$': '<rootDir>/../database/schema/index.ts',
  },
  cacheDirectory: '<rootDir>/../node_modules/.cache/auth-jest',
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
