import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const noEnums = { selector: 'TSEnumDeclaration', message: 'Use a union of string literals, not an enum.' };
const approvalsAreTheUsers = {
  selector:
    ":matches(MemberExpression[property.name='resolveApproval'], ImportSpecifier[imported.name='resolveApproval'])",
  message:
    'Only the approval handler in apps/desktop/src/app/tools.ts resolves approvals: they are the user’s, never an agent’s.',
};
const tradedIdIsTheAccounts = [
  {
    selector: "Literal[value='orders.contract_for']",
    message: 'Only apps/desktop/src/market/contracts.ts asks an account for the contract it trades.',
  },
  {
    selector: 'Identifier[name=/^(withRoot|executionOf|executionChoices)$/]',
    message: 'A traded id is never built from strings: the account’s answer is its only producer.',
  },
];
const loadingSaysNothing = [
  ...[
    'JSXText[value=/^\\s*Loading\\b/]',
    'Literal[value=/^Loading .*…$/]',
    'TemplateElement[value.raw=/^Loading .*…$/]',
    'JSXText[value=/(Taking a picture|Gathering what happened|Connecting)[^<]*…/]',
  ].map((selector) => ({ selector, message: 'A surface that loads says nothing in words: it shows its skeleton.' })),
  {
    selector: 'Literal[value=/\\bspinner\\b|animate-spin/i]',
    message: 'A surface that loads shows its skeleton, never a spinner.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.astro/**',
      '**/.wrangler/**',
      '**/target/**',
      '**/.perf/**',
      'apps/desktop/src-tauri/**',
      'crates/**',
      'design/**',
      'docs/**',
      '.e2e/**',
      '.agents/**',
      '.claude/**',
      'packages/protocol/src/gen/**',
      'packages/protocol/src/schemas.gen.ts',
      'packages/ui/icons/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', 'packages/*/scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: true }],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/no-unsafe-enum-assignment': 'off',
      'no-restricted-syntax': ['error', noEnums],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/desktop/src/**/*.tsx'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    ignores: ['packages/bridge/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@tauri-apps/*'], message: 'Only @tessera/bridge may import @tauri-apps/*.' }] },
      ],
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['apps/desktop/src/app/tools.ts', 'packages/protocol/**'],
    rules: {
      'no-restricted-syntax': ['error', noEnums, approvalsAreTheUsers],
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    ignores: ['apps/desktop/src/app/tools.ts', 'apps/desktop/src/market/contracts.ts'],
    rules: {
      'no-restricted-syntax': ['error', noEnums, approvalsAreTheUsers, ...tradedIdIsTheAccounts, ...loadingSaysNothing],
    },
  },
  {
    files: ['apps/desktop/src/app/tools.ts'],
    rules: { 'no-restricted-syntax': ['error', noEnums, ...tradedIdIsTheAccounts, ...loadingSaysNothing] },
  },
  {
    files: ['apps/desktop/src/market/contracts.ts'],
    rules: { 'no-restricted-syntax': ['error', noEnums, approvalsAreTheUsers, ...loadingSaysNothing] },
  },
  {
    files: ['**/test/**', '**/*.test.{ts,tsx}', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/scripts/*.mjs', 'apps/desktop/dev/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['fixtures/research/**/*.js'],
    languageOptions: { globals: { ta: 'readonly', session: 'readonly', draw: 'readonly' } },
  },
  prettier,
);
