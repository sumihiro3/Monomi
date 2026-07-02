import { describe, expect, it } from 'vitest'
import { ProjectKeyNormalizer } from './project-key-normalizer.js'
import { projectKeyEquals, type NormalizeContext } from './project-key.js'

const normalizer = new ProjectKeyNormalizer()

/** git remote があるケースの正規化文脈（cwd/commonDir はキーに影響しない）。 */
const gitCtx: NormalizeContext = {
  deviceId: 'macmini-1',
  cwd: '/Users/sumihiro/dev/ProjectLens',
  isGitRepo: true,
}

/**
 * §0.1 FR-03 AC-1/AC-2 のゴールデンテスト10件。
 *
 * SSH（scp / ssh://）・HTTPS・`.git` の有無・GitLab ネストサブグループ・ポート付き・
 * 大小文字混在（host）・認証情報付きを網羅する。SSH と HTTPS の同一リポジトリが
 * 同一 `project_key`（下表の #1〜#6 は全て `github.com/sumihiro/ProjectLens`）へ
 * 収束することを表として固定する。
 */
const GOLDEN: ReadonlyArray<{ name: string; input: string; expected: string }> = [
  {
    name: 'HTTPS with .git suffix',
    input: 'https://github.com/sumihiro/ProjectLens.git',
    expected: 'github.com/sumihiro/ProjectLens',
  },
  {
    name: 'SSH scp form with .git suffix',
    input: 'git@github.com:sumihiro/ProjectLens.git',
    expected: 'github.com/sumihiro/ProjectLens',
  },
  {
    name: 'HTTPS without .git suffix',
    input: 'https://github.com/sumihiro/ProjectLens',
    expected: 'github.com/sumihiro/ProjectLens',
  },
  {
    name: 'SSH scp form without .git suffix',
    input: 'git@github.com:sumihiro/ProjectLens',
    expected: 'github.com/sumihiro/ProjectLens',
  },
  {
    name: 'ssh:// URL form with explicit port',
    input: 'ssh://git@github.com:22/sumihiro/ProjectLens.git',
    expected: 'github.com/sumihiro/ProjectLens',
  },
  {
    name: 'HTTPS with explicit port',
    input: 'https://github.com:443/sumihiro/ProjectLens.git',
    expected: 'github.com/sumihiro/ProjectLens',
  },
  {
    name: 'GitLab nested subgroups over HTTPS',
    input: 'https://gitlab.com/group/subgroup/team/repo.git',
    expected: 'gitlab.com/group/subgroup/team/repo',
  },
  {
    name: 'GitLab nested subgroups over SSH scp form',
    input: 'git@gitlab.com:group/subgroup/team/repo.git',
    expected: 'gitlab.com/group/subgroup/team/repo',
  },
  {
    name: 'HTTPS with mixed-case host and token auth (host lowercased, owner/repo preserved)',
    input: 'https://x-access-token:ghs_secret@GitHub.com/Sumihiro/ProjectLens.git',
    expected: 'github.com/Sumihiro/ProjectLens',
  },
  {
    name: 'self-hosted ssh:// with non-standard port',
    input: 'ssh://git@git.example.com:2222/owner/repo.git',
    expected: 'git.example.com/owner/repo',
  },
]

describe('ProjectKeyNormalizer.normalize — golden cases (§0.1 FR-03 AC-1)', () => {
  it.each(GOLDEN)('normalizes $name', ({ input, expected }) => {
    const key = normalizer.normalize(input, gitCtx)
    expect(key.value).toBe(expected)
    expect(key.kind).toBe('GIT_REMOTE')
  })

  it('produces exactly 10 golden cases', () => {
    expect(GOLDEN).toHaveLength(10)
  })
})

describe('ProjectKeyNormalizer.normalize — SSH/HTTPS equivalence (§0.1 FR-03 AC-2)', () => {
  it('maps the same repository over SSH and HTTPS to an identical project_key', () => {
    const https = normalizer.normalize('https://github.com/sumihiro/ProjectLens.git', gitCtx)
    const ssh = normalizer.normalize('git@github.com:sumihiro/ProjectLens.git', gitCtx)
    expect(projectKeyEquals(https, ssh)).toBe(true)
    expect(https.value).toBe('github.com/sumihiro/ProjectLens')
  })

  it('collapses .git presence, port, and host case differences to one key', () => {
    const variants = [
      'https://github.com/sumihiro/ProjectLens.git',
      'https://github.com/sumihiro/ProjectLens',
      'https://github.com:443/sumihiro/ProjectLens.git',
      'ssh://git@github.com:22/sumihiro/ProjectLens.git',
      'git@github.com:sumihiro/ProjectLens.git',
      'git@GitHub.com:sumihiro/ProjectLens.git',
    ]
    const keys = variants.map((v) => normalizer.normalize(v, gitCtx).value)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('github.com/sumihiro/ProjectLens')
  })
})

describe('ProjectKeyNormalizer.normalize — non-remote / non-git (§0.1 cross-device isolation)', () => {
  it('prefixes a remote-less git repo with local:{device_id} using common-dir when available', () => {
    const key = normalizer.normalize(null, {
      deviceId: 'macmini-1',
      cwd: '/Users/sumihiro/dev/scratch-worktrees/feature',
      isGitRepo: true,
      commonDir: '/Users/sumihiro/dev/scratch/.git',
    })
    expect(key.value).toBe('local:macmini-1:/Users/sumihiro/dev/scratch/.git')
    expect(key.kind).toBe('LOCAL_NO_REMOTE')
  })

  it('falls back to cwd for a remote-less git repo when common-dir is not provided', () => {
    const key = normalizer.normalize('', {
      deviceId: 'macmini-1',
      cwd: '/Users/sumihiro/dev/scratch',
      isGitRepo: true,
    })
    expect(key.value).toBe('local:macmini-1:/Users/sumihiro/dev/scratch')
    expect(key.kind).toBe('LOCAL_NO_REMOTE')
  })

  it('prefixes a non-git directory with nogit:{device_id}', () => {
    const key = normalizer.normalize(null, {
      deviceId: 'mbp-2',
      cwd: '/tmp/scratch',
      isGitRepo: false,
    })
    expect(key.value).toBe('nogit:mbp-2:/tmp/scratch')
    expect(key.kind).toBe('NO_GIT')
  })

  it('treats a non-git directory as nogit even if a remote string is somehow supplied', () => {
    const key = normalizer.normalize('git@github.com:sumihiro/ProjectLens.git', {
      deviceId: 'mbp-2',
      cwd: '/tmp/scratch',
      isGitRepo: false,
    })
    expect(key.kind).toBe('NO_GIT')
    expect(key.value).toBe('nogit:mbp-2:/tmp/scratch')
  })

  it('keeps the same local repo distinct across devices (no cross-device fusion)', () => {
    const onMini = normalizer.normalize(null, {
      deviceId: 'macmini-1',
      cwd: '/Users/sumihiro/dev/scratch',
      isGitRepo: true,
    })
    const onMbp = normalizer.normalize(null, {
      deviceId: 'mbp-2',
      cwd: '/Users/sumihiro/dev/scratch',
      isGitRepo: true,
    })
    expect(projectKeyEquals(onMini, onMbp)).toBe(false)
  })
})

describe('projectKey value object helpers', () => {
  it('trims trailing slash and .git together', () => {
    const key = normalizer.normalize('https://github.com/sumihiro/ProjectLens.git/', gitCtx)
    expect(key.value).toBe('github.com/sumihiro/ProjectLens')
  })

  it('projectKeyEquals compares both value and kind', () => {
    const a = normalizer.normalize('https://github.com/o/r.git', gitCtx)
    const b = normalizer.normalize('git@github.com:o/r.git', gitCtx)
    expect(projectKeyEquals(a, b)).toBe(true)
  })

  it('returns a frozen (immutable) ProjectKey', () => {
    const key = normalizer.normalize('https://github.com/o/r.git', gitCtx)
    expect(Object.isFrozen(key)).toBe(true)
  })
})
