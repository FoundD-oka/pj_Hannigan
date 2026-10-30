import { describe, expect, test } from 'bun:test'
import { ReliableLink } from '../../relay/link.ts'

// two links joined by a socket that can be cut; a frame sent while cut is lost like on a real dropped connection
function pair() {
  const gotA: number[] = []
  const gotB: number[] = []
  const a = new ReliableLink<number, number>(n => gotA.push(n))
  const b = new ReliableLink<number, number>(n => gotB.push(n))
  const up = () => {
    a.attach(t => b.receive(t))
    b.attach(t => a.receive(t))
  }
  const down = () => {
    a.detach()
    b.detach()
  }
  const resume = () => {
    up()
    const [la, lb] = [a.lastSeen, b.lastSeen]
    a.resume(lb)
    b.resume(la)
  }
  up()
  return { a, b, gotA, gotB, down, resume }
}

describe('ReliableLink', () => {
  test('delivers in order and clears the queue on ack', () => {
    const { a, b, gotB } = pair()
    a.send(1)
    a.send(2)
    expect(gotB).toEqual([1, 2])
    expect(a.pending).toBe(0)
    expect(b.lastSeen).toBe(2)
  })

  test('frames sent while the socket is down arrive once, in order, after resume', () => {
    const { a, b, gotA, gotB, down, resume } = pair()
    a.send(1)
    down()
    a.send(2)
    a.send(3)
    b.send(10)
    expect(a.pending).toBe(2)
    resume()
    expect(gotB).toEqual([1, 2, 3])
    expect(gotA).toEqual([10])
    expect(a.pending + b.pending).toBe(0)
  })

  test('a frame delivered right before the drop is not delivered twice', () => {
    const got: number[] = []
    const b = new ReliableLink<number, number>(n => got.push(n))
    const sent: string[] = []
    const a = new ReliableLink<number, number>(() => {})
    a.attach(t => sent.push(t))
    a.send(1)
    b.receive(sent[0]) // arrived, but the ack was lost with the socket
    expect(a.pending).toBe(1)
    a.detach()
    a.attach(t => b.receive(t))
    a.resume(0) // the worst case: the peer's lastSeen is stale, so it is sent again
    expect(got).toEqual([1])
  })

  test('a gap is not delivered out of order', () => {
    const got: number[] = []
    const b = new ReliableLink<number, number>(n => got.push(n))
    b.receive(JSON.stringify({ seq: 2, body: 2 }))
    expect(got).toEqual([])
    expect(b.lastSeen).toBe(0)
  })

  test('overflow is reported and reset starts over', () => {
    let overflowed = 0
    const a = new ReliableLink<number, number>(() => {}, () => overflowed++, 2)
    a.send(1)
    a.send(2)
    a.send(3)
    expect(overflowed).toBe(1)
    a.reset()
    expect(a.pending).toBe(0)
    expect(a.lastSeen).toBe(0)
  })

  test('junk on the socket is ignored', () => {
    const got: number[] = []
    const b = new ReliableLink<number, number>(n => got.push(n))
    b.receive('not json')
    expect(got).toEqual([])
  })
})
