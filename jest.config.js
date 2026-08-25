module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    setupFiles: ['<rootDir>/tests/helpers/setupEnv.js'],
    collectCoverageFrom: [
        'middleware/**/*.js',
        'routes/**/*.js',
        'services/**/*.js',
        'utils/**/*.js',
        '!**/node_modules/**'
    ],
    clearMocks: true,
    verbose: false
};
