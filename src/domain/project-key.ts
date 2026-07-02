import type { ProjectKeyKind } from './enums.js'
import type { ProjectKey } from './entities.js'

/**
 * 正規化済みプロジェクト識別子の値オブジェクト（§0.1）。
 *
 * 構造（`{ value, kind }`）は §7.3 `projects.project_key` 列に対応する純粋な
 * データとして {@link ./entities.js} で定義される。本モジュールはその「振る舞い」
 * （生成・等価判定）と正規化に必要な文脈（{@link NormalizeContext}）を提供し、
 * `ProjectKeyNormalizer` と合わせて値オブジェクトとしての責務一式をこの場所に集約する。
 * `value` が DB にそのまま格納されるため、メソッドを持つクラスにはせず
 * シリアライズ可能な plain record に留め、`equals` は {@link projectKeyEquals} で表す。
 */
export type { ProjectKey }

/**
 * `ProjectKeyNormalizer.normalize` に渡す正規化文脈（§0.1）。
 *
 * `deviceId` を鍵に前置することで、remote を持たないプロジェクトが別デバイス間で
 * 同一 `project_key` に融合するのを構造的に禁止する。
 */
export interface NormalizeContext {
  /** レポート送信元デバイスの `device_id`（§7.3 `devices.id`）。 */
  deviceId: string
  /** 現在のディレクトリ（非 git / remote 無し git のキー生成に使う）。 */
  cwd: string
  /** 対象ディレクトリが git 作業ツリーか。false なら常に `nogit:` キーになる。 */
  isGitRepo: boolean
  /**
   * `git rev-parse --git-common-dir` 相当の共有 git ディレクトリ（§0.1: remote 無し
   * git は `local:{device_id}:{common-dir}`）。worktree を主リポジトリへ融合させるための
   * 権威パス。レポーターが算出しない場合は未指定でよく、その際は {@link cwd} を用いる。
   */
  commonDir?: string
}

/**
 * {@link ProjectKey} を生成する唯一のファクトリ。
 *
 * 値オブジェクトの不変性を担保するため凍結して返す。生成経路を一箇所に絞ることで、
 * `value`/`kind` の整合しない ProjectKey が生まれないようにする。
 *
 * @param value 正規化済みの文字列表現（例 `github.com/owner/repo`）。
 * @param kind 由来（{@link ProjectKeyKind}）。
 * @returns 凍結済みの {@link ProjectKey}。
 */
export function createProjectKey(value: string, kind: ProjectKeyKind): ProjectKey {
  return Object.freeze({ value, kind })
}

/**
 * 正規化済みの `project_key` 文字列から由来（{@link ProjectKeyKind}）を復元する。
 *
 * §7.3 `projects` テーブルは `project_key`（value）のみを保持し `kind` 列を持たないため、
 * DB から {@link ProjectKey} を再構成する際に接頭辞から kind を逆算する。接頭辞は
 * {@link ./project-key-normalizer.js ProjectKeyNormalizer} が付与する `nogit:` / `local:`
 * のみで、`GIT_REMOTE` は必ず `host/owner/repo` 形（先頭がホスト名）になり、これらの
 * 接頭辞と衝突しない（ホスト名は `:` の直後にコロンを伴わない）ため一意に判別できる。
 *
 * @param value 正規化済みの `project_key` 文字列。
 * @returns 対応する {@link ProjectKeyKind}。
 */
export function inferProjectKeyKind(value: string): ProjectKeyKind {
  if (value.startsWith('nogit:')) return 'NO_GIT'
  if (value.startsWith('local:')) return 'LOCAL_NO_REMOTE'
  return 'GIT_REMOTE'
}

/**
 * 2 つの {@link ProjectKey} が同一かを判定する（クラス図の `equals` の関数版）。
 *
 * `value` は由来ごとの接頭辞（`local:`/`nogit:`）を含むため `value` 一致だけでも
 * 実質等価だが、由来の取り違えを防ぐため `kind` も併せて比較する。
 *
 * @param a 比較対象。
 * @param b 比較対象。
 * @returns `value` と `kind` がともに一致すれば true。
 */
export function projectKeyEquals(a: ProjectKey, b: ProjectKey): boolean {
  return a.value === b.value && a.kind === b.kind
}
