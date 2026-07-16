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
    focusTerminal: vi.fn(),
  }
}

describe('KeyBindingController — 詳細ビューの隣接プロジェクト移動（FR-04 AC-1）', () => {
  it('detail 中に ← で host.moveProject(-1) を呼び true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('', keys({ leftArrow: true }), 'detail')

    expect(host.moveProject).toHaveBeenCalledTimes(1)
    expect(host.moveProject).toHaveBeenCalledWith(-1)
    expect(dispatched).toBe(true)
  })

  it('detail 中に → で host.moveProject(+1) を呼び true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('', keys({ rightArrow: true }), 'detail')

    expect(host.moveProject).toHaveBeenCalledTimes(1)
    expect(host.moveProject).toHaveBeenCalledWith(1)
    expect(dispatched).toBe(true)
  })

  it('list 中は ←/→ があっても host.moveProject を呼ばず false を返す（release-20-dashboard-heap-guard FR-03 AC-3）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const leftResult = controller.handleKey('', keys({ leftArrow: true }), 'list')
    const rightResult = controller.handleKey('', keys({ rightArrow: true }), 'list')

    expect(host.moveProject).not.toHaveBeenCalled()
    expect(leftResult).toBe(false)
    expect(rightResult).toBe(false)
  })
})

describe('KeyBindingController — j/k・↑/↓ は list モードのみ moveSelection を呼ぶ（release-6 で detail 中はイベントスクロールへ再割当て、DetailView 側が消費）', () => {
  it('list 中は j で moveSelection(+1)、k で moveSelection(-1) を呼び、どちらも true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const jResult = controller.handleKey('j', keys(), 'list')
    const kResult = controller.handleKey('k', keys(), 'list')

    expect(host.moveSelection).toHaveBeenNthCalledWith(1, 1)
    expect(host.moveSelection).toHaveBeenNthCalledWith(2, -1)
    expect(jResult).toBe(true)
    expect(kResult).toBe(true)
  })

  it('list 中は ↓/↑ でも moveSelection を呼び true を返す（vim 流と矢印の両対応）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const downResult = controller.handleKey('', keys({ downArrow: true }), 'list')
    const upResult = controller.handleKey('', keys({ upArrow: true }), 'list')

    expect(host.moveSelection).toHaveBeenNthCalledWith(1, 1)
    expect(host.moveSelection).toHaveBeenNthCalledWith(2, -1)
    expect(downResult).toBe(true)
    expect(upResult).toBe(true)
  })

  it('detail 中は j/k・↑/↓ があっても moveSelection を呼ばず false を返す（DetailView 自身の useInput が消費する、release-20-dashboard-heap-guard FR-03 AC-3）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const jResult = controller.handleKey('j', keys(), 'detail')
    const kResult = controller.handleKey('k', keys(), 'detail')
    const downResult = controller.handleKey('', keys({ downArrow: true }), 'detail')
    const upResult = controller.handleKey('', keys({ upArrow: true }), 'detail')

    expect(host.moveSelection).not.toHaveBeenCalled()
    expect(jResult).toBe(false)
    expect(kResult).toBe(false)
    expect(downResult).toBe(false)
    expect(upResult).toBe(false)
  })
})

describe('KeyBindingController — viewMode によらず常に有効な操作は不変', () => {
  it('esc は list/detail どちらでも host.back を呼び true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const listResult = controller.handleKey('', keys({ escape: true }), 'list')
    const detailResult = controller.handleKey('', keys({ escape: true }), 'detail')

    expect(host.back).toHaveBeenCalledTimes(2)
    expect(listResult).toBe(true)
    expect(detailResult).toBe(true)
  })

  it('detail 中に esc を渡しても moveProject より back が優先される（← / → 以外は従来通り）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    controller.handleKey('', keys({ escape: true }), 'detail')

    expect(host.back).toHaveBeenCalledOnce()
    expect(host.moveProject).not.toHaveBeenCalled()
  })

  it('? は viewMode によらず host.toggleHelp を呼び true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('?', keys(), 'detail')

    expect(host.toggleHelp).toHaveBeenCalledOnce()
    expect(dispatched).toBe(true)
  })

  it('q は viewMode によらず host.quit を呼び true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('q', keys(), 'detail')

    expect(host.quit).toHaveBeenCalledOnce()
    expect(dispatched).toBe(true)
  })

  it('f は list 中に host.focusTerminal を呼び true を返す（FR-05b AC-1）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('f', keys(), 'list')

    expect(host.focusTerminal).toHaveBeenCalledOnce()
    expect(dispatched).toBe(true)
  })

  it('f は detail 中にも host.focusTerminal を呼び true を返す（FR-05b AC-1）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('f', keys(), 'detail')

    expect(host.focusTerminal).toHaveBeenCalledOnce()
    expect(dispatched).toBe(true)
  })
})

describe('KeyBindingController — 無効キーは false を返す（release-20-dashboard-heap-guard FR-03 AC-3）', () => {
  it('フィルタ・移動・詳細開閉・戻る・ヘルプ・終了のいずれにも該当しないキーは false を返し、host / store を一切変更しない', () => {
    const store = new InstanceListStore()
    const host = makeHost()
    const controller = new KeyBindingController(store, host)

    const dispatched = controller.handleKey('x', keys(), 'list')

    expect(dispatched).toBe(false)
    expect(host.moveSelection).not.toHaveBeenCalled()
    expect(host.openDetail).not.toHaveBeenCalled()
    expect(host.moveProject).not.toHaveBeenCalled()
    expect(host.back).not.toHaveBeenCalled()
    expect(host.toggleHelp).not.toHaveBeenCalled()
    expect(host.quit).not.toHaveBeenCalled()
    expect(host.focusTerminal).not.toHaveBeenCalled()
    expect(store.activeFilters).toEqual([])
  })

  it('detail 中に無効キーを渡しても false を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('x', keys(), 'detail')

    expect(dispatched).toBe(false)
  })
})

describe('KeyBindingController — list モードの既存挙動は不変（FR-04 の回帰確認）', () => {
  it('detail 中はフィルタキー（1-5）を無視し false を返す', () => {
    const store = new InstanceListStore()
    const host = makeHost()
    const controller = new KeyBindingController(store, host)

    const dispatched = controller.handleKey('1', keys(), 'detail')

    expect(store.activeFilters).toEqual([])
    expect(dispatched).toBe(false)
  })

  it('list 中はフィルタキー（1）でトグルし true を返す', () => {
    const store = new InstanceListStore()
    const host = makeHost()
    const controller = new KeyBindingController(store, host)

    const dispatched = controller.handleKey('1', keys(), 'list')

    expect(store.activeFilters).toEqual(['active'])
    expect(dispatched).toBe(true)
  })

  it('list 中は Enter で host.openDetail を呼び true を返す', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('', keys({ return: true }), 'list')

    expect(host.openDetail).toHaveBeenCalledOnce()
    expect(dispatched).toBe(true)
  })

  it('detail 中は Enter を無視する（openDetail を呼ばず false を返す）', () => {
    const host = makeHost()
    const controller = new KeyBindingController(new InstanceListStore(), host)

    const dispatched = controller.handleKey('', keys({ return: true }), 'detail')

    expect(host.openDetail).not.toHaveBeenCalled()
    expect(dispatched).toBe(false)
  })
})
