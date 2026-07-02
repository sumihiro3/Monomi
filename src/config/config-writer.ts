import fs from 'node:fs'
import { parseDocument } from 'yaml'
import { CONFIG_FILE_MODE } from './config.js'

/**
 * `monomi pair` が config.yml へ書き込む child ペアリング設定（FR-01 / FR-02b）。
 */
export interface ChildPairingConfig {
  /** 役割。ペアリング済みデバイスは常に `child`。 */
  role: 'child'
  /** hub 到達先候補（優先順）。`http://host:port` の配列（§0.2 / FR-04）。 */
  hubEndpoints: string[]
  /** このデバイスの device_id（claim 時に hub へ申告した値）。 */
  deviceId: string
}

/**
 * child の config.yml に role / hub_endpoints / device_id を部分書き込みする（FR-02b / AC-3）。
 *
 * bootstrap の device_id 書き戻しと同じく zod スキーマ（既定値補完・未知キー除去）を通さず
 * YAML Document を直接編集し、手作業で書かれたコメント・他キー（`port`・`watch_interval` 等）を
 * 保持する。書き込み後は device_token を持つ可能性のある機微ファイルとして `chmod 600` に固定する
 * （{@link CONFIG_FILE_MODE}）。
 *
 * ## 既存 config とのマージ規則（未解決事項の確定）
 * - `role`: 常に `child` で**上書き**する（ペアリングはこのデバイスを child 化する操作のため）。
 * - `device_id`: 引数値で**上書き**する。呼び出し側は「既存 device_id があればそれ、無ければ
 *   hostname 由来の派生値」を渡すため、既存 id は保持され再ペアリングでも同一 id を維持する。
 * - `hub_endpoints`: 引数の配列で**丸ごと置換**する（`- ` ブロックシーケンス記法。bash reporter が
 *   `sed` で行単位に読める形式、config.ts のスキーマ注釈に一致）。呼び出し側で「`--hub` 指定＋既存
 *   endpoints の重複排除ユニオン」を組み立て済みの前提。
 * - 上記 3 キー以外（`port`・閾値・コメント等）は一切変更しない。
 *
 * @param configFile 出力先（`~/.monomi/config.yml`）。
 * @param config 書き込む role / hub_endpoints / device_id。
 */
export function writeChildPairingConfig(configFile: string, config: ChildPairingConfig): void {
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
  const doc = parseDocument(existing)
  doc.set('role', config.role)
  doc.set('device_id', config.deviceId)
  // 配列を渡すと yaml は既定でブロックシーケンス（`- item`）で描画する（フロー記法にしない）。
  doc.set('hub_endpoints', config.hubEndpoints)
  fs.writeFileSync(configFile, doc.toString(), { mode: CONFIG_FILE_MODE })
  fs.chmodSync(configFile, CONFIG_FILE_MODE)
}
