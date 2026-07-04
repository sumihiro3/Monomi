import packageJson from '../package.json' with { type: 'json' }

/**
 * パッケージのバージョン文字列（`monomi --version` が表示する値）。
 *
 * 葉モジュールとして独立させている理由: `src/index.ts`（公開 API バレル）がこの値を
 * re-export する一方、`app-view.tsx`・`help-overlay.tsx` 等の内部コンポーネントも TUI 表示用に
 * この値を必要とする。もし内部コンポーネントが `index.ts` から直接 import すると、
 * `index.ts` → `app-view.tsx` → `index.ts` の循環依存が生じる（`index.ts` は `AppView` を
 * re-export しているため）。バレルへの逆依存はバレル自身の「実装詳細の変更を外部へ波及させない」
 * という責務を壊すため、値の定義はここへ切り出し、バレル・内部コンポーネントの双方から
 * 一方向に参照させる（review-changes 修正）。
 */
export const MONOMI_VERSION: string = packageJson.version
