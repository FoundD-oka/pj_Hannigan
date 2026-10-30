// Ordered, exactly-once delivery of JSON frames over a socket that may drop and come back.
// Both ends of the Mac <-> relay connection keep one link for as long as their process lives: unacknowledged frames
// stay queued while the socket is gone and are sent again after the two ends compare what they received (`resume`).
// A process restart loses the queue; the handshake's epoch tells the other end to reset (see relay/protocol.ts).

type Queued = { seq: number; text: string }

export class ReliableLink<In = unknown, Out = unknown> {
  private outSeq = 0
  private inSeq = 0
  private unacked: Queued[] = []
  private sendRaw: ((text: string) => void) | null = null

  constructor(
    private onFrame: (body: In) => void,
    private onOverflow: () => void = () => {},
    private maxUnacked = 20000,
  ) {}

  // last in-order frame received; the peer resends everything after it
  get lastSeen(): number {
    return this.inSeq
  }

  get pending(): number {
    return this.unacked.length
  }

  attach(sendRaw: (text: string) => void): void {
    this.sendRaw = sendRaw
  }

  detach(): void {
    this.sendRaw = null
  }

  // the peer's lastSeen after a (re)connect: drop what it already has and send the rest again, in order
  resume(peerLastSeen: number): void {
    this.dropThrough(peerLastSeen)
    // a copy: an ack may arrive while sending
    for (const q of [...this.unacked]) this.sendRaw?.(q.text)
  }

  reset(): void {
    this.outSeq = 0
    this.inSeq = 0
    this.unacked = []
  }

  send(body: Out): void {
    const seq = ++this.outSeq
    const text = JSON.stringify({ seq, body })
    this.unacked.push({ seq, text })
    if (this.unacked.length > this.maxUnacked) {
      this.onOverflow()
      return
    }
    this.sendRaw?.(text)
  }

  // one text message from the socket
  receive(text: string): void {
    let m: { seq?: number; ack?: number; body?: In }
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (typeof m.ack === 'number') this.dropThrough(m.ack)
    if (typeof m.seq !== 'number') return
    // a frame past the next one means an earlier one was lost with the old socket: the resume sends it again
    if (m.seq === this.inSeq + 1) {
      this.inSeq = m.seq
      this.onFrame(m.body as In)
    }
    if (m.seq <= this.inSeq) this.sendRaw?.(JSON.stringify({ ack: this.inSeq }))
  }

  private dropThrough(seq: number): void {
    let i = 0
    while (i < this.unacked.length && this.unacked[i].seq <= seq) i++
    if (i) this.unacked.splice(0, i)
  }
}
