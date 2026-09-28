import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// T3: запрет HTML-вставок. Тот же запрет продублирован правилами semgrep (.semgrep.yml).
const xssMessage = 'XSS: только textContent / JSX-экранирование (раздел 10.6)';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.cache/**',
      'docs/openapi/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: xssMessage },
        { property: 'outerHTML', message: xssMessage },
        { property: 'insertAdjacentHTML', message: xssMessage },
        { property: 'srcdoc', message: xssMessage },
        { object: 'document', property: 'write', message: xssMessage },
        { object: 'document', property: 'writeln', message: xssMessage },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: xssMessage },
        {
          selector: "CallExpression[callee.property.name='createContextualFragment']",
          message: xssMessage,
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
    },
  },
  {
    files: ['apps/admin/**/*.{ts,tsx}', 'packages/web-player/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/admin/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Сценарии k6 выполняются в рантайме k6, а не в Node.
    files: ['ops/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
  {
    files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx', '**/e2e/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
