// Messages of the OpenMausBot <-> Mac relay. docs/design/05-omb-mac-relay.md.
//
//   OpenMausBot -- ACP over stdio --> acp-client.ts -- unix socket --> server.ts <-- wss, opened by the Mac -- mac-agent.ts
//
// The relay carries ACP lines without reading them. One `ch` is one acp-client process (OpenMausBot starts one per
// conversation and may replace it at any time); the Claude Code sessions belong to the Mac and outlive channels.

// relay -> Mac, through ReliableLink
export type ToMac = { t: 'open'; ch: string } | { t: 'line'; ch: string; line: string } | { t: 'close'; ch: string }
// Mac -> relay, through ReliableLink
export type FromMac = { t: 'line'; ch: string; line: string }

// the WebSocket handshake, outside ReliableLink. `epoch` is random per process: a new one means the other end restarted
// and lost its queue, so both sides reset and every open channel ends.
export type MacHello = { t: 'hello'; mac: string; key: string; epoch: string; lastSeen: number }
export type RelayWelcome = { t: 'welcome'; epoch: string; lastSeen: number }
export type RelayDenied = { t: 'denied'; reason: string }

// acp-client <-> relay, one JSON object per line on the unix socket
export type ClientToRelay = { t: 'connect'; mac: string } | { t: 'line'; line: string }
export type RelayToClient = { t: 'state'; online: boolean } | { t: 'line'; line: string } | { t: 'error'; message: string }

// the relay's own CLI <-> daemon, on the same unix socket
export type AdminRequest = { t: 'issue_code'; mac: string } | { t: 'status' }
export type AdminReply =
  | { t: 'code'; mac: string; code: string; expires_at: string }
  | { t: 'status'; macs: { mac: string; online: boolean; channels: number; queued: number }[] }
  | { t: 'error'; message: string }

export const RELAY_PATH = '/hannigan-relay'
export const DEFAULT_RELAY_PORT = 8820
export const PING_MS = 20000
export const DEAD_AFTER_MS = 50000
