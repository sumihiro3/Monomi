import { describe, expect, it, vi } from 'vitest'
import { InstanceListStore } from './instance-list-store.js'
import {
  KeyBindingController,
  type KeyBindingHost,
  type KeyFlags,
} from './key-binding-controller.js'

/** 未指定フラグを全て false 埋めした {@link KeyFlags} を作る（テストの記述量を減らす）。 */
function keys(overrides: Partial<KeyFlags> = {}): KeyFlags {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ...overrides,
  }
}

/** spy を仕込んだ {@link KeyBindingHost} を作る。 */
function makeHost(): KeyBindingHost {
  return {
    moveSelection: vi.fn(),
    openDetail: vi.fn(),
    moveProject: vi.fn(),
    back: vi.fn(),
    toggleHelp: vi.fn(),
    quit: vi.fn(),
  }
}

describe('KeyBindingController — 詳細ビューの隣接プロジェクト移動（FR-04 AC-1）', () => {
  it('detail 中に ← で host.moveProject(-1) を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ leftArrow: true }), 'detail')

    expect(host.moveProject).toHaveBeenCalledTimes(1)
    expect(host.moveProject).toHaveBeenCalledWith(-1)
  })

  it('detail 中に → で host.moveProject(+1) を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ rightArrow: true }), 'detail')

    expect(host.moveProject).toHaveBeenCalledTimes(1)
    expect(host.moveProject).toHaveBeenCalledWith(1)
  })

  it('list 中は ←/→ があっても host.moveProject を呼ばない', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ leftArrow: true }), 'list')
    controller.handleKey('', keys({ rightArrow: true }), 'list')

    expect(host.moveProject).not.toHaveBeenCalled()
  })
})

describe('KeyBindingController — j/k・↑/↓ は list モードのみ moveSelection を呼ぶ（release-6 で detail 中はイベントスクロールへ再割当て、DetailView 側が消費）', () => {
  it('list 中は j で moveSelection(+1)、k で moveSelection(-1) を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('j', keys(), 'list')
    controller.handleKey('k', keys(), 'list')

    expect(host.moveSelection).toHaveBeenNthCalledWith(1, 1)
    expect(host.moveSelection).toHaveBeenNthCalledWith(2, -1)
  })

  it('list 中は ↓/↑ でも moveSelection を呼ぶ（vim 流と矢印の両対応）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ downArrow: true }), 'list')
    controller.handleKey('', keys({ upArrow: true }), 'list')

    expect(host.moveSelection).toHaveBeenNthCalledWith(1, 1)
    expect(host.moveSelection).toHaveBeenNthCalledWith(2, -1)
  })

  it('detail 中は j/k・↑/↓ があっても moveSelection を呼ばない（DetailView 自身の useInput が消費する）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('j', keys(), 'detail')
    controller.handleKey('k', keys(), 'detail')
    controller.handleKey('', keys({ downArrow: true }), 'detail')
    controller.handleKey('', keys({ upArrow: true }), 'detail')

    expect(host.moveSelection).not.toHaveBeenCalled()
  })
})

describe('KeyBindingController — viewMode によらず常に有効な操作は不変', () => {
  it('esc は list/detail どちらでも host.back を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ escape: true }), 'list')
    controller.handleKey('', keys({ escape: true }), 'detail')

    expect(host.back).toHaveBeenCalledTimes(2)
  })

  it('detail 中に esc を渡しても moveProject より back が優先される（← / → 以外は従来通り）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ escape: true }), 'detail')

    expect(host.back).toHaveBeenCalledOnce()
    expect(host.moveProject).not.toHaveBeenCalled()
  })

  it('? は viewMode によらず host.toggleHelp を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('?', keys(), 'detail')

    expect(host.toggleHelp).toHaveBeenCalledOnce()
  })

  it('q は viewMode によらず host.quit を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('q', keys(), 'detail')

    expect(host.quit).toHaveBeenCalledOnce()
  })
})

describe('KeyBindingController — list モードの既存挙動は不変（FR-04 の回帰確認）', () => {
  it('detail 中はフィルタキー（1-5）を無視する', () => {
    const store = new InstanceListStore()
    const host = makeHost()
    const controller = new KeyBindingController(store, host)

    controller.handleKey('1', keys(), 'detail')

    expect(store.activeFilters).toEqual([])
  })

  it('list 中は Enter で host.openDetail を呼ぶ', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ return: true }), 'list')

    expect(host.openDetail).toHaveBeenCalledOnce()
  })

  it('detail 中は Enter を無視する（openDetail を呼ばない）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ return: true }), 'detail')

    expect(host.openDetail).not.toHaveBeenCalled()
  })
})
