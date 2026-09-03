// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/core/test/fixtures/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated lint project, because the build tsconfigs only cover `src` and
        // type-aware rules have to see the tests and the vitest config too.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The web app is the only browser code here, so `window`, `document` and friends are
    // scoped to it rather than declared globally – a `location` in the server would be a bug.
    files: ['packages/web/**/*.{ts,tsx}'],
    // `configs.flat` is the flat-config shape; `configs['recommended-latest']` is still
    // the eslintrc one, whose `plugins` is an array of strings.
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        MessageEvent: 'readonly',
        RequestInit: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        React: 'readonly',
      },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
