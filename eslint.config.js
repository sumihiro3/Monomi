// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    // .claude/workflows/*.js は Workflow tool 専用の実行コンテキストを持つスクリプトで、
    // 通常の JS/TS ソースではないため lint 対象から外す。
    ignores: ['dist/**', 'node_modules/**', '.claude/**'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        // CLI は Ink（React）で JSX を書くため、パーサに JSX 解釈を許可する。
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // `_` プレフィックスの引数・変数（意図的な未使用。例: 使わない `_req`）は許容する慣習に合わせる。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
]
