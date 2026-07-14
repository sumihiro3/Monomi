#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * CHANGELOG.md から指定バージョンのリリースノート本文を抽出する CLI（release-22 FR-01）。
 *
 * `publish.yml` の GitHub Release 作成ステップから呼び出し、`gh release create` へ渡す
 * リリースノート本文を作る。空のリリースノートが Release として公開される事態を避けるため、
 * 該当バージョンの見出しが無い場合・本文が空の場合はいずれも非0で終了する（fail fast）。
 */

const HEADING_PATTERN = /^## \[([^\]]+)\].*$/gm

/**
 * CHANGELOG.md 本文から、指定バージョンの節（次の `## [` 見出し直前まで。
 * 最古のバージョンなど後続見出しが無い場合は EOF まで）を抽出する。
 *
 * @param changelog CHANGELOG.md のファイル内容全体。
 * @param version 抽出対象バージョン（例: `0.1.2`）。`## [` と `]` は含めない。
 * @returns 前後の空白を trim したリリースノート本文。
 * @throws 該当バージョンの見出しが見つからない場合、または本文が空の場合。
 */
export function extractChangelogNotes(changelog, version) {
  const headings = []
  for (const match of changelog.matchAll(HEADING_PATTERN)) {
    headings.push({
      version: match[1],
      start: match.index,
      headingEnd: match.index + match[0].length,
    })
  }

  const targetIndex = headings.findIndex((heading) => heading.version === version)
  if (targetIndex === -1) {
    throw new Error(`CHANGELOG.md に "${version}" の見出しが見つかりません`)
  }

  const target = headings[targetIndex]
  const next = headings[targetIndex + 1]
  const bodyEnd = next ? next.start : changelog.length
  const body = changelog.slice(target.headingEnd, bodyEnd).trim()

  if (body === '') {
    throw new Error(`"${version}" のリリースノート本文が空です`)
  }

  return body
}

/**
 * CLI エントリポイント。
 *
 * 使用法: `node scripts/extract-changelog-notes.mjs <version> [changelogPath]`
 * `changelogPath` を省略した場合はリポジトリ直下の `CHANGELOG.md` を読む。
 */
function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('使用法: node scripts/extract-changelog-notes.mjs <version> [changelogPath]')
    process.exit(1)
    return
  }

  const changelogPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'CHANGELOG.md')

  try {
    const changelog = readFileSync(changelogPath, 'utf8')
    const notes = extractChangelogNotes(changelog, version)
    process.stdout.write(`${notes}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main()
}
