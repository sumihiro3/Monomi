import { describe, expect, it } from 'vitest'
import { mapPrToStatus, type GhPrInfo } from './pr-status-mapper.js'

describe('mapPrToStatus', () => {
  it('maps "no PR" (null) to none', () => {
    expect(mapPrToStatus(null)).toEqual({ state: 'none', isDraft: false })
  })

  it('maps CLOSED (unmerged) to none', () => {
    const pr: GhPrInfo = { state: 'CLOSED', reviewDecision: null, isDraft: false }
    expect(mapPrToStatus(pr)).toEqual({ state: 'none', isDraft: false })
  })

  it('maps OPEN with no review decision to awaiting_review', () => {
    const pr: GhPrInfo = { state: 'OPEN', reviewDecision: null, isDraft: false }
    expect(mapPrToStatus(pr)).toEqual({ state: 'awaiting_review', isDraft: false })
  })

  it('maps OPEN with REVIEW_REQUIRED to awaiting_review', () => {
    const pr: GhPrInfo = { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false }
    expect(mapPrToStatus(pr)).toEqual({ state: 'awaiting_review', isDraft: false })
  })

  it('maps OPEN with CHANGES_REQUESTED to changes_requested', () => {
    const pr: GhPrInfo = { state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', isDraft: false }
    expect(mapPrToStatus(pr)).toEqual({ state: 'changes_requested', isDraft: false })
  })

  it('maps OPEN with APPROVED to approved', () => {
    const pr: GhPrInfo = { state: 'OPEN', reviewDecision: 'APPROVED', isDraft: false }
    expect(mapPrToStatus(pr)).toEqual({ state: 'approved', isDraft: false })
  })

  it('maps MERGED to merged', () => {
    const pr: GhPrInfo = { state: 'MERGED', reviewDecision: 'APPROVED', isDraft: false }
    expect(mapPrToStatus(pr)).toEqual({ state: 'merged', isDraft: false })
  })

  it('AC-2: a draft PR with no review decision is is_draft:true and state:awaiting_review', () => {
    const pr: GhPrInfo = { state: 'OPEN', reviewDecision: null, isDraft: true }
    expect(mapPrToStatus(pr)).toEqual({ state: 'awaiting_review', isDraft: true })
  })

  it('AC-2: a draft PR under REVIEW_REQUIRED is also is_draft:true and state:awaiting_review', () => {
    const pr: GhPrInfo = { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: true }
    expect(mapPrToStatus(pr)).toEqual({ state: 'awaiting_review', isDraft: true })
  })
})
