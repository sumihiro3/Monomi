import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // CLI は実 TTY での利用を前提に ANSI カラーを描画する（instance-card.tsx 等の
    // 選択色・強調色）。テスト実行環境（CI・サンドボックス等）は非 TTY のことが多く、
    // chalk が自動で色出力を無効化してしまうと ANSI エスケープを検証するテストが
    // 環境依存で失敗する。FORCE_COLOR を明示し、実 TTY と同じ色出力で決定的に検証する。
    env: {
      FORCE_COLOR: '1',
    },
  },
})
