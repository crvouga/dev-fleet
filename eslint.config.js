import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'cliproxy', '.mise'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Control characters are matched on purpose: output is sanitised.
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      complexity: ['error', 12],
      'max-params': ['error', 4],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Fixtures and entry points print on purpose.
    files: ['**/*.test.ts', 'tests/**', 'ansible/**/tests/**', 'bootstrap/**'],
    rules: { 'no-console': 'off', complexity: 'off', 'max-params': 'off' },
  }
);
