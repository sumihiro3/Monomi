import { createProjectKey, type NormalizeContext, type ProjectKey } from './project-key.js'

/**
 * git remote の表記ゆれを吸収し {@link ProjectKey} を生成する唯一の実装（§0.1）。
 *
 * レポーター（bash / PowerShell）は `git remote get-url origin` の生出力をそのまま
 * 送り、正規化はこの hub 側 Node 実装に一本化する。二重実装による表記ゆれで同一
 * リポジトリが横断ダッシュボードで複数行に割れるのを防ぐため、他のどのクラスも
 * 正規化の詳細を知らない。
 *
 * 正規化手順（§0.1）:
 * 1. scheme（`https://` / `ssh://` 等）と認証情報（`user[:pass]@` / `git@`）を除去。
 * 2. host を小文字化し、ポートを除去。
 * 3. 末尾の `.git` と余分なスラッシュを除去。
 * 4. `host/owner/repo` 形式に固定（GitLab のネストサブグループはパスを丸ごと保持）。
 *
 * 非 remote / 非 git は device_id を前置してクロスデバイス融合を構造的に禁止する。
 */
export class ProjectKeyNormalizer {
  /**
   * 生の remote URL と文脈から {@link ProjectKey} を導出する。
   *
   * @param rawRemoteUrl `git remote get-url origin` の生出力。remote が無い / 取得
   *   できない場合は null（または空文字）。
   * @param ctx デバイス・cwd・git 判定を含む正規化文脈。
   * @returns 正規化済みの {@link ProjectKey}。
   */
  normalize(rawRemoteUrl: string | null, ctx: NormalizeContext): ProjectKey {
    // 非 git は常に nogit:（remote の有無より git 判定を優先）。
    if (!ctx.isGitRepo) {
      return createProjectKey(`nogit:${ctx.deviceId}:${ctx.cwd}`, 'NO_GIT')
    }

    const raw = rawRemoteUrl?.trim() ?? ''
    if (raw === '') {
      // remote 無し git。common-dir があれば worktree を主リポジトリへ融合できる。
      const localPath = ctx.commonDir ?? ctx.cwd
      return createProjectKey(`local:${ctx.deviceId}:${localPath}`, 'LOCAL_NO_REMOTE')
    }

    const hostAndPath = this.stripSchemeAndAuth(raw)
    return createProjectKey(this.toHostOwnerRepo(hostAndPath), 'GIT_REMOTE')
  }

  /**
   * scheme と認証情報を除去し `host[:port]/path` 形式へ揃える。
   *
   * scp 形式（`git@host:owner/repo.git`）は host と path を分ける区切りコロンを
   * スラッシュへ変換し、以降を URL 形式と同一に扱えるようにする。
   */
  private stripSchemeAndAuth(url: string): string {
    const trimmed = url.trim()
    const schemeMatch = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)

    if (schemeMatch) {
      // URL 形式: scheme://[userinfo@]host[:port]/path
      let rest = trimmed.slice(schemeMatch[0].length)
      const firstSlash = rest.indexOf('/')
      const boundary = firstSlash === -1 ? rest.length : firstSlash
      // userinfo は authority 内（最初の `/` より前）の最後の `@` まで。
      const at = rest.lastIndexOf('@', boundary - 1)
      if (at !== -1) {
        rest = rest.slice(at + 1)
      }
      return rest
    }

    // scp 形式: [user@]host:path（scheme を持たない）
    let rest = trimmed
    const firstColon = rest.indexOf(':')
    const at = rest.indexOf('@')
    // `@` が host:path の区切りコロンより前にある場合のみ userinfo とみなす。
    if (at !== -1 && (firstColon === -1 || at < firstColon)) {
      rest = rest.slice(at + 1)
    }
    // host:path の区切りコロンをスラッシュへ変換して URL 形式と統一する。
    const colon = rest.indexOf(':')
    if (colon !== -1) {
      rest = rest.slice(0, colon) + '/' + rest.slice(colon + 1)
    }
    return rest
  }

  /**
   * `host[:port]/path` を `host/owner/repo` へ正規化する。
   *
   * host は小文字化しポートを除去する。owner/repo の大小文字は §0.1 に従い保持する
   * （host のみ小文字化）。末尾 `.git` と余分なスラッシュは取り除く。GitLab の
   * ネストサブグループは owner が多階層になるため、path 全体をそのまま保持する。
   */
  private toHostOwnerRepo(hostAndPath: string): string {
    const firstSlash = hostAndPath.indexOf('/')
    const authority = firstSlash === -1 ? hostAndPath : hostAndPath.slice(0, firstSlash)
    const rawPath = firstSlash === -1 ? '' : hostAndPath.slice(firstSlash + 1)

    const host = authority.replace(/:\d+$/, '').toLowerCase()
    const path = rawPath
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')

    return path ? `${host}/${path}` : host
  }
}
