import js from '@eslint/js';
import security from 'eslint-plugin-security';
import { fixupPluginRules } from '@eslint/compat';

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'data/**'] },
  js.configs.recommended,
  {
    ...security.configs.recommended,
    plugins: { security: fixupPluginRules(security) }
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        Buffer: 'readonly', process: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', queueMicrotask: 'readonly'
      }
    },
    rules: { 'security/detect-object-injection': 'off' }
  }
];
