const eslint = require('@eslint/js');
const globals = require('globals');
const jestPlugin = require('eslint-plugin-jest');

module.exports = [
  eslint.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off'
    }
  },
  {
    files: ['tests/**/*.test.js'],
    plugins: {
      jest: jestPlugin
    },
    languageOptions: {
      globals: {
        ...globals.jest
      }
    },
    rules: {
      ...jestPlugin.configs.recommended.rules
    }
  },
  {
    ignores: ['node_modules/', 'public/', 'docs/']
  }
];
