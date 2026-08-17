import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { PageRetention, RETAINED_PAGES } from '../src/renderer/src/pdf/pageRetention'

/**
 * The point of these tests is the BOUND. Deferring cleanup() is a memory
 * trade, and the reason it is allowed to exist at all is that retention is
 * capped rather than unbounded. An unverified bound is not a bound.
 */

interface FakePage {
  cleanup(): void
  cleaned: number
}

function page(): FakePage {
  return {
    cleaned: 0,
    cleanup(): void {
      this.cleaned += 1
    }
  }
}

/** Distinct object identities standing in for PDFDocumentProxy. */
const docA = { name: 'A' }
const docB = { name: 'B' }

describe('PageRetention bounding', () => {
  it('never holds more than the cap, however many pages are visited', () => {
    const cache = new PageRetention(3)
    const pages: FakePage[] = []
    // The failure this guards against: scrolling a large sheet set retaining
    // every page ever visited. 138 is the real Kincora page count.
    for (let n = 1; n <= 138; n++) {
      const p = page()
      pages.push(p)
      cache.retain(docA, n, p)
      assert.ok(cache.size <= 3, `cap exceeded at page ${n}: size ${cache.size}`)
    }
    assert.equal(cache.size, 3)
    // Everything except the last 3 was cleaned up exactly once.
    const cleaned = pages.filter((p) => p.cleaned > 0).length
    assert.equal(cleaned, 135)
    assert.ok(pages.slice(-3).every((p) => p.cleaned === 0), 'the newest 3 must still be held')
    assert.ok(pages.every((p) => p.cleaned <= 1), 'no page may be cleaned twice')
  })

  it('evicts least-recently-retained first', () => {
    const cache = new PageRetention(2)
    const p1 = page()
    const p2 = page()
    const p3 = page()
    cache.retain(docA, 1, p1)
    cache.retain(docA, 2, p2)
    cache.retain(docA, 3, p3)
    assert.equal(p1.cleaned, 1, 'oldest evicted')
    assert.equal(p2.cleaned, 0)
    assert.equal(p3.cleaned, 0)
  })

  it('re-retaining a page refreshes its position rather than duplicating it', () => {
    const cache = new PageRetention(2)
    const p1 = page()
    const p2 = page()
    const p3 = page()
    cache.retain(docA, 1, p1)
    cache.retain(docA, 2, p2)
    cache.retain(docA, 1, p1) // page 1 is now the most recent
    assert.equal(cache.size, 2, 'no duplicate entry')
    cache.retain(docA, 3, p3)
    assert.equal(p2.cleaned, 1, 'page 2 is now the oldest and is evicted')
    assert.equal(p1.cleaned, 0, 'refreshed page survives')
  })

  it('a mounted page does not occupy a slot', () => {
    // release() is what keeps the cap governing UNMOUNTED retention only. If
    // it did not remove the entry, a page cycling in and out of view would
    // consume a slot permanently.
    const cache = new PageRetention(2)
    const p1 = page()
    const p2 = page()
    const p3 = page()
    cache.retain(docA, 1, p1)
    cache.release(docA, 1)
    assert.equal(cache.size, 0)
    cache.retain(docA, 2, p2)
    cache.retain(docA, 3, p3)
    assert.equal(cache.size, 2)
    assert.equal(p1.cleaned, 0, 'a released page is the caller’s problem, not cleaned here')
  })

  it('keys by document identity, so two documents do not collide', () => {
    // Same page number in two documents must be two entries. Keying by page
    // number alone would hand document B's page 1 back for document A.
    const cache = new PageRetention(4)
    const a1 = page()
    const b1 = page()
    cache.retain(docA, 1, a1)
    cache.retain(docB, 1, b1)
    assert.equal(cache.size, 2)
    cache.release(docA, 1)
    assert.equal(cache.size, 1, 'releasing A:1 must not release B:1')
  })

  it('flushDoc releases only that document, and all of it', () => {
    // Closing a tab must release its worker resources. Anything left here
    // would outlive the document that owns it.
    const cache = new PageRetention(6)
    const a1 = page()
    const a2 = page()
    const b1 = page()
    cache.retain(docA, 1, a1)
    cache.retain(docA, 2, a2)
    cache.retain(docB, 1, b1)
    cache.flushDoc(docA)
    assert.equal(a1.cleaned, 1)
    assert.equal(a2.cleaned, 1)
    assert.equal(b1.cleaned, 0, 'the other document is untouched')
    assert.equal(cache.size, 1)
  })

  it('a cap of 0 restores the original clean-up-immediately behaviour', () => {
    // The escape hatch if retention ever costs more memory than it saves time.
    const cache = new PageRetention(0)
    const p1 = page()
    cache.retain(docA, 1, p1)
    assert.equal(p1.cleaned, 1)
    assert.equal(cache.size, 0)
  })

  it('reports cleanups, hits and misses distinctly', () => {
    // These three counters exist to separate failure modes that all look like
    // "Page Request did not move": working (hits high), cap too small (misses
    // and evictions high), and not wired to the real path (neither fires).
    const events: string[] = []
    const cache = new PageRetention(1, (e) => events.push(e))

    const p1 = page()
    cache.retain(docA, 1, p1)
    assert.deepEqual(events, [], 'retain alone reports nothing')

    assert.equal(cache.release(docA, 1), true)
    assert.deepEqual(events, ['hit'])

    assert.equal(cache.release(docA, 99), false)
    assert.deepEqual(events, ['hit', 'miss'], 'a page never retained is a miss')

    cache.retain(docA, 2, page())
    cache.retain(docA, 3, page())
    assert.deepEqual(events, ['hit', 'miss', 'cleanup'], 'exceeding the cap reports a cleanup')

    cache.flushAll()
    assert.deepEqual(events, ['hit', 'miss', 'cleanup', 'cleanup'])
  })

  it('release reports a miss for an evicted page, which is the cap-too-small signal', () => {
    const cache = new PageRetention(2)
    const p1 = page()
    cache.retain(docA, 1, p1)
    cache.retain(docA, 2, page())
    cache.retain(docA, 3, page()) // evicts page 1
    assert.equal(p1.cleaned, 1)
    assert.equal(cache.release(docA, 1), false, 'evicted page misses, and will be re-parsed')
    assert.equal(cache.release(docA, 3), true, 'still-held page hits')
  })

  it('setCapacity applies immediately when lowered', () => {
    // A sweep must not carry pages across settings, so lowering the cap has to
    // evict now rather than at the next retain.
    const cache = new PageRetention(4)
    const pages = [page(), page(), page(), page()]
    pages.forEach((p, i) => cache.retain(docA, i + 1, p))
    assert.equal(cache.size, 4)

    cache.setCapacity(2)
    assert.equal(cache.size, 2)
    assert.equal(pages[0].cleaned, 1)
    assert.equal(pages[1].cleaned, 1)
    assert.equal(pages[2].cleaned, 0)
    assert.equal(pages[3].cleaned, 0)
  })

  it('setCapacity raised does not evict, and takes effect for later retains', () => {
    const cache = new PageRetention(2)
    cache.retain(docA, 1, page())
    cache.retain(docA, 2, page())
    cache.setCapacity(12)
    assert.equal(cache.capacity, 12)
    assert.equal(cache.size, 2, 'raising the cap must not disturb what is held')
    for (let n = 3; n <= 12; n++) cache.retain(docA, n, page())
    assert.equal(cache.size, 12)
    cache.retain(docA, 13, page())
    assert.equal(cache.size, 12, 'the new cap is still a cap')
  })

  it('rejects a negative or fractional cap rather than misbehaving', () => {
    const cache = new PageRetention(-5)
    assert.equal(cache.capacity, 0)
    cache.setCapacity(2.7)
    assert.equal(cache.capacity, 2)
  })

  it('ships with a cap of at least two mounted windows, and still bounded', () => {
    // A cap equal to ONE mounted window never hits on A -> B -> A: the window
    // arriving at B evicts A's pages just before they are needed again.
    // Measured at cap 3 with a 3-page window: 0 hits, 9 misses.
    const MOUNTED_WINDOW = 3 // 2 * OVERSCAN_PAGES + 1, with OVERSCAN_PAGES = 1
    assert.ok(
      RETAINED_PAGES >= 2 * MOUNTED_WINDOW,
      `RETAINED_PAGES=${RETAINED_PAGES} is under two mounted windows (${2 * MOUNTED_WINDOW}); A->B->A will never hit`
    )
    assert.ok(RETAINED_PAGES <= 12, `RETAINED_PAGES=${RETAINED_PAGES} is no longer a bound`)
  })

  it('two mounted windows survive A -> B -> A without a single eviction', () => {
    // The regression test for the cap-3 pathology, as a pure simulation of the
    // navigation that exposed it.
    const WINDOW = [1, 2, 3]
    const FAR = [136, 137, 138]
    const pages = new Map<number, FakePage>()
    const pageFor = (n: number): FakePage => {
      if (!pages.has(n)) pages.set(n, page())
      return pages.get(n)!
    }

    let hits = 0
    let misses = 0
    const cache = new PageRetention(2 * WINDOW.length, (e) => {
      if (e === 'hit') hits++
      else if (e === 'miss') misses++
    })

    const visit = (arriving: number[], outgoing: number[]): void => {
      for (const n of outgoing) cache.retain(docA, n, pageFor(n))
      for (const n of arriving) cache.release(docA, n)
    }

    visit(FAR, WINDOW) // 1->138: retains 1,2,3; 136-138 are first visits
    visit(WINDOW, FAR) // back to 1: must HIT
    visit(FAR, WINDOW) // to 138 again: must HIT

    assert.equal(misses, 3, 'only the three genuinely-first visits should miss')
    assert.equal(hits, 6, 'both later windows should hit in full')
    assert.ok(
      [...pages.values()].every((p) => p.cleaned === 0),
      'two windows fit, so nothing should have been evicted'
    )
    assert.equal(cache.size, 3, 'the outgoing window is still held')
  })
})
