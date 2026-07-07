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
      // Ink は is-in-ci が CI 環境を検知すると中間フレームの書き出しを抑制するため、
      // GitHub Actions（CI=true）では ink-testing-library の lastFrame() が空文字になり
      // コンポーネントテストが環境依存で失敗する（release-17 CI 導入時に実測）。
      // is-in-ci は CI / CONTINUOUS_INTEGRATION の2変数のみを見るため（'false' は無効値）、
      // 両方を明示的に 'false' へ固定し、実 TTY と同じ逐次描画で決定的に検証する。
      CI: 'false',
      CONTINUOUS_INTEGRATION: 'false',
    },
  },
})
