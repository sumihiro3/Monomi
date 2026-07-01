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
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
]
