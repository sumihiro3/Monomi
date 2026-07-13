import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePaths } from '../config/paths.js'
import {
  DEFAULT_BACKPRESSURE_THRESHOLD_BYTES,
  DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT,
  DEFAULT_SAMPLE_INTERVAL_MS,
  isStdoutBackpressured,
  MemoryWatchdog,
} from './memory-watchdog.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-memory-watchdog-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** テスト用のメモリ使用量スタブ。 */
function fakeMemoryUsage(overrides: Partial<NodeJS.MemoryUsage> = {}): () => NodeJS.MemoryUsage {
  return () => ({
    rss: 100,
    heapTotal: 80,
    heapUsed: 40,
    external: 10,
    arrayBuffers: 5,
    ...overrides,
  })
}

describe('isStdoutBackpressured (FR-02 AC-1/AC-4)', () => {
  it('returns false when writableLength is below the threshold', () => {
    expect(
      isStdoutBackpressured({ writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES - 1 })
    ).toBe(false)
  })

  it('returns true when writableLength equals the threshold', () => {
    expect(isStdoutBackpressured({ writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES })).toBe(
      true
    )
  })

  it('returns true when writableLength exceeds the threshold', () => {
    expect(
      isStdoutBackpressured({ writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES + 1 })
    ).toBe(true)
  })

  it('honors a caller-supplied threshold instead of the default', () => {
    expect(isStdoutBackpressured({ writableLength: 100 }, 200)).toBe(false)
    expect(isStdoutBackpressured({ writableLength: 200 }, 200)).toBe(true)
  })

  it('performs no I/O (pure function over the passed-in source)', () => {
    // writableLength だけを持つ最小オブジェクトでも動く = 実 stream に依存しないことの確認。
    const source = { writableLength: 0 }
    expect(isStdoutBackpressured(source)).toBe(false)
    expect(Object.keys(source)).toEqual(['writableLength'])
  })
})

describe('MemoryWatchdog.sample (FR-01 AC-2/AC-6)', () => {
  it('appends exactly one INFO line per sample in the documented format', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const now = () => new Date('2026-07-13T00:00:00.000Z')
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage({
        rss: 111,
        heapTotal: 222,
        heapUsed: 333,
        external: 4,
        arrayBuffers: 5,
      }),
      stdout: { writableLength: 0 },
      now,
    })

    watchdog.sample()

    const content = fs.readFileSync(paths.cliLogFile, 'utf8')
    const lines = content.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(
      '2026-07-13T00:00:00.000Z INFO rss=111 heapTotal=222 heapUsed=333 external=4 arrayBuffers=5 writableLength=0'
    )
  })

  it('creates ~/.monomi (via ensureMonomiHome) before writing when it does not exist yet', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    expect(fs.existsSync(paths.home)).toBe(false)
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout: { writableLength: 0 },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })

    watchdog.sample()

    expect(fs.existsSync(paths.home)).toBe(true)
    expect(fs.statSync(paths.home).mode & 0o777).toBe(0o700)
    expect(fs.existsSync(paths.cliLogFile)).toBe(true)
  })

  it('appends multiple samples as separate lines (1 line per sample)', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout: { writableLength: 0 },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })

    watchdog.sample()
    watchdog.sample()
    watchdog.sample()

    const lines = fs
      .readFileSync(paths.cliLogFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
  })

  it('never calls process.exit (AC-4: logging only, no crash recovery)', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called')
    })
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      // 3回連続の閾値超過（WARN 経路）でも exit しないことを確認する。
      stdout: { writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })

    expect(() => {
      watchdog.sample()
      watchdog.sample()
      watchdog.sample()
    }).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()

    exitSpy.mockRestore()
  })
})

describe('MemoryWatchdog — WARN on 3 consecutive backpressure samples (FR-01 AC-3/AC-6)', () => {
  it('stays INFO for the first two consecutive over-threshold samples, then emits WARN on the third', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const stdout = { writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES + 1 }
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })

    watchdog.sample()
    watchdog.sample()
    watchdog.sample()

    const lines = fs
      .readFileSync(paths.cliLogFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain(' INFO ')
    expect(lines[1]).toContain(' INFO ')
    expect(lines[2]).toContain(' WARN ')
    expect(lines[2]).toContain(`thresholdBytes=${DEFAULT_BACKPRESSURE_THRESHOLD_BYTES}`)
    expect(lines[2]).toContain('consecutiveOverThreshold=3')
  })

  it('resets the consecutive counter once writableLength drops back below the threshold', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const stdout = { writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES + 1 }
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })

    watchdog.sample() // 1
    watchdog.sample() // 2
    stdout.writableLength = 0 // ドレインされた
    watchdog.sample() // カウンタリセット
    stdout.writableLength = DEFAULT_BACKPRESSURE_THRESHOLD_BYTES + 1
    watchdog.sample() // 1 (再カウント開始)
    watchdog.sample() // 2

    const lines = fs
      .readFileSync(paths.cliLogFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(5)
    // リセットされたため、5行の中に WARN は出ない。
    expect(lines.every((l) => l.includes(' INFO '))).toBe(true)
  })

  it('honors a custom warnConsecutiveCount', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout: { writableLength: DEFAULT_BACKPRESSURE_THRESHOLD_BYTES },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      warnConsecutiveCount: 1,
    })

    watchdog.sample()

    const lines = fs
      .readFileSync(paths.cliLogFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines[0]).toContain(' WARN ')
  })
})

describe('MemoryWatchdog.start/stop (DI timer, AC-4: no process.exit / unref)', () => {
  it('samples immediately on start, then again every intervalMs via the injected timer', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const captured: { handler: (() => void) | null; ms: number | null } = {
      handler: null,
      ms: null,
    }
    const unref = vi.fn()
    const setIntervalFn = vi.fn((handler: () => void, ms: number) => {
      captured.handler = handler
      captured.ms = ms
      return { unref } as unknown as ReturnType<typeof setInterval>
    })
    const clearIntervalFn = vi.fn()
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout: { writableLength: 0 },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      setIntervalFn,
      clearIntervalFn,
      intervalMs: 12_345,
    })

    watchdog.start()

    // 開始時に即1回サンプリングする。
    expect(
      fs
        .readFileSync(paths.cliLogFile, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    ).toHaveLength(1)
    expect(setIntervalFn).toHaveBeenCalledTimes(1)
    expect(captured.ms).toBe(12_345)
    // timer は unref され、プロセスの自然な終了を妨げない。
    expect(unref).toHaveBeenCalledTimes(1)
    expect(watchdog.isRunning()).toBe(true)

    // 注入したタイマーの handler を手動で発火 = 実インターバル待ちなしで tick を検証。
    captured.handler?.()
    expect(
      fs
        .readFileSync(paths.cliLogFile, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    ).toHaveLength(2)

    watchdog.stop()
    expect(clearIntervalFn).toHaveBeenCalledTimes(1)
    expect(watchdog.isRunning()).toBe(false)
  })

  it('is idempotent: calling start() twice does not register a second timer', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const setIntervalFn = vi.fn(
      () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
    )
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout: { writableLength: 0 },
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    })

    watchdog.start()
    watchdog.start()

    expect(setIntervalFn).toHaveBeenCalledTimes(1)
  })

  it('stop() is a no-op when not running', () => {
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const clearIntervalFn = vi.fn()
    const watchdog = new MemoryWatchdog(paths, {
      memoryUsage: fakeMemoryUsage(),
      stdout: { writableLength: 0 },
      clearIntervalFn,
    })

    watchdog.stop()

    expect(clearIntervalFn).not.toHaveBeenCalled()
  })
})

describe('default constants', () => {
  it('exposes the documented defaults (FR-01/FR-02)', () => {
    expect(DEFAULT_SAMPLE_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES).toBe(64 * 1024)
    expect(DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT).toBe(3)
  })
})
