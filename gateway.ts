import { Buffer } from "node:buffer";
import type {
  ProtocolConversation, ProtocolIncomingMessage, ProtocolMessagePart, ProtocolPeer, ProtocolReceipt, ProtocolReplyPart,
  ProtocolScope, ReverseProtocolGateway,
} from "./protocol.ts";

export const gsuidCoreAdapter = "gsuidcore";
/** The legacy TRSS reverse endpoint. The outward Gscore connection is independent. */
export const gsuidCoreReversePath = "/GSUIDCore";
export const gsuidCoreMaxFrameBytes = 16 * 1024 * 1024;
const maxFileBytes = 10 * 1024 * 1024;

type WireTarget = "direct" | "group" | "channel" | "sub_channel";
type ReplyTarget = Pick<ProtocolIncomingMessage, "scope" | "conversation" | "replyTo">;
type WirePart = { type: "text" | "at" | "reply" | "image" | "record" | "file"; data: string };

export interface GsuidCoreBotIdentity {
  readonly platform: string;
  readonly account: string;
}

export interface GsuidCoreGatewayOptions {
  readonly instance: string;
  readonly enabled?: boolean;
  /** Optional exact remote account allowlist in addition to the host's peer authentication. */
  readonly identities?: readonly GsuidCoreBotIdentity[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function id(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string" || !value.length || value.length > 256 || value !== value.trim() ||
      !value.isWellFormed() || /[\p{Cc}\p{Cs}]/u.test(value)) return;
  return value;
}

function frameSize(text: string) {
  return text.length > gsuidCoreMaxFrameBytes ? Infinity : Buffer.byteLength(text);
}

function incomingConversation(type: unknown, user: string, group: unknown): ProtocolConversation | undefined {
  if (type === "direct") return { kind: "private", id: user };
  const target = id(group);
  if (!target) return;
  switch (type) {
    case "group": return { kind: "group", id: target };
    case "channel": return { kind: "channel", id: target };
    case "sub_channel": return { kind: "channel", transportKind: "sub_channel", id: target };
  }
}

function outgoingConversation(conversation: ProtocolConversation): WireTarget | undefined {
  if (conversation.parentId !== undefined) return;
  if (conversation.transportKind !== undefined) {
    return conversation.kind === "channel" && conversation.transportKind === "sub_channel" ? "sub_channel" : undefined;
  }
  switch (conversation.kind) {
    case "private": return "direct";
    case "group": return "group";
    case "channel": return "channel";
  }
}

function parsePart(value: Record<string, unknown>): ProtocolMessagePart | undefined {
  const { type, data } = value;
  if (type === "at") {
    const mention = id(data);
    return mention ? { type: "mention", id: mention } : undefined;
  }
  if (typeof data !== "string" || !data.length || !data.isWellFormed()) return;
  switch (type) {
    case "text": return { type: "text", text: data };
    case "image": return { type: "image", id: data };
    case "record": return { type: "audio", id: data };
    case "video": return { type: "video", id: data };
    case "file": {
      const separator = data.indexOf("|");
      const name = separator > 0 && separator <= 256 ? id(data.slice(0, separator)) : undefined;
      return { type: "file", id: data, ...(name && { name }) };
    }
  }
}

/** The reverse endpoint receives the old MessageReceive shape, regardless of the actor's platform. */
export function decodeGsuidCoreMessage(frame: string, instance: string): ProtocolIncomingMessage | undefined {
  if (!id(instance) || frameSize(frame) > gsuidCoreMaxFrameBytes) return;
  let message: Record<string, unknown> | undefined;
  try { message = record(JSON.parse(frame)); }
  catch { return; }
  if (!message || !Array.isArray(message.content)) return;
  const platform = id(message.bot_id), account = id(message.bot_self_id), actor = id(message.user_id), messageId = id(message.msg_id);
  if (!platform || !account || !actor || !messageId) return;
  const conversation = incomingConversation(message.user_type, actor, message.group_id);
  if (!conversation) return;

  const parts: ProtocolMessagePart[] = [];
  let replyTo: string | undefined;
  for (const segment of message.content) {
    const value = record(segment);
    if (!value) continue;
    if (value.type === "reply") {
      const target = id(value.data);
      if (!target || (replyTo !== undefined && replyTo !== target)) return;
      replyTo = target;
      continue;
    }
    // Markup, buttons and forwarded messages are not command input. In particular, do not execute quoted text.
    const part = parsePart(value);
    if (part) parts.push(part);
  }
  if (!parts.length) return;
  return {
    scope: { adapter: gsuidCoreAdapter, instance, platform, account },
    conversation, actor, messageId, parts, ...(replyTo && { replyTo }),
  };
}

/** Keep legacy reverse serialization, including base64:// for files and videos and reply segments. */
export function encodeGsuidCoreReply(message: ReplyTarget, parts: readonly ProtocolReplyPart[]): string | undefined {
  const { scope, conversation, replyTo } = message;
  if (scope.adapter !== gsuidCoreAdapter || !id(scope.instance)) return;
  const platform = id(scope.platform), account = id(scope.account), target = id(conversation.id);
  const wireType = outgoingConversation(conversation);
  if (!platform || !account || !target || !wireType || !parts.length || (replyTo !== undefined && !id(replyTo))) return;

  const content: WirePart[] = replyTo ? [{ type: "reply", data: replyTo }] : [];
  let bytes = 0;
  for (const part of parts) {
    if (part.type === "text" || part.type === "mention") {
      const data = part.type === "text" ? part.text : id(part.id);
      if (!data || !data.isWellFormed()) return;
      bytes += frameSize(data);
      if (bytes > gsuidCoreMaxFrameBytes) return;
      content.push({ type: part.type === "text" ? "text" : "at", data });
    } else {
      if (!part.bytes.length || part.bytes.length > maxFileBytes) return;
      bytes += 4 * Math.ceil(part.bytes.length / 3);
      if (bytes > gsuidCoreMaxFrameBytes) return;
      const type = part.type === "audio" ? "record" : part.type === "image" ? "image" : "file";
      content.push({ type, data: `base64://${Buffer.from(part.bytes.buffer, part.bytes.byteOffset, part.bytes.byteLength).toString("base64")}` });
    }
  }

  const frame = JSON.stringify({ bot_id: platform, bot_self_id: account, target_type: wireType, target_id: target, content });
  if (frameSize(frame) <= gsuidCoreMaxFrameBytes) return frame;
}

function botKey(platform: string, account: string) {
  return JSON.stringify([platform, account]);
}

function scopedBotKey(scope: ProtocolScope) {
  return scope.platform === undefined ? undefined : botKey(scope.platform, scope.account);
}

interface Session {
  readonly peer: ProtocolPeer;
  readonly identities: Set<string>;
}

export function createGsuidCoreGateway(options: GsuidCoreGatewayOptions): ReverseProtocolGateway {
  const { enabled = false, instance } = options;
  if (!id(instance)) throw new TypeError("早柚核心实例名无效。");
  const allowedBots = options.identities && new Set(options.identities.map(({ platform, account }) => {
    if (typeof platform !== "string" || !id(platform) || typeof account !== "string" || !id(account)) {
      throw new TypeError("早柚核心平台或机器人标识无效。");
    }
    return botKey(platform, account);
  }));
  const sessions = new Map<ProtocolPeer, Session>();
  const byIdentity = new Map<string, Session>();
  let active: { receive: (message: ProtocolIncomingMessage) => Promise<void>; signal: AbortSignal } | undefined;

  function detach(session: Session) {
    if (sessions.get(session.peer) !== session) return;
    sessions.delete(session.peer);
    for (const key of session.identities) byIdentity.delete(key);
  }

  return {
    async start(receive, signal) {
      if (!enabled || signal.aborted) return;
      if (active) throw new Error("早柚核心适配器已启动。");
      active = { receive, signal };
      try {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        active = undefined;
        for (const session of sessions.values()) {
          detach(session);
          try { session.peer.close(); } catch { /* Continue closing the remaining peers. */ }
        }
      }
    },
    accept(peer) {
      const run = active;
      if (!run || run.signal.aborted || sessions.has(peer)) return;
      const session: Session = { peer, identities: new Set() };
      sessions.set(peer, session);
      return {
        async receive(frame) {
          if (run.signal.aborted || active !== run || sessions.get(peer) !== session) return;
          const incoming = decodeGsuidCoreMessage(frame, instance);
          const key = incoming && scopedBotKey(incoming.scope);
          if (!incoming || !key || (allowedBots && !allowedBots.has(key))) return;
          const tracked = byIdentity.get(key);
          if (tracked && tracked !== session) return;
          if (!tracked) {
            byIdentity.set(key, session);
            session.identities.add(key);
          }
          await run.receive(incoming);
        },
        close() { detach(session); },
      };
    },
    async send(message, parts, signal): Promise<ProtocolReceipt> {
      if (!enabled || message.scope.adapter !== gsuidCoreAdapter || message.scope.instance !== instance) return { status: "unsupported" };
      if (!active || active.signal.aborted || signal.aborted) return { status: "rejected" };
      const key = scopedBotKey(message.scope);
      const target = key && byIdentity.get(key);
      if (!target) return { status: "rejected" };
      const frame = encodeGsuidCoreReply(message, parts);
      if (!frame) return { status: "unsupported" };
      try {
        if (!target.peer.send(frame)) return { status: "rejected" };
      } catch { /* Delivery is ambiguous after attempting the transport write. */ }
      // Socket enqueue is not a delivery acknowledgement, and there is no remote message ID.
      return { status: "unknown" };
    },
  };
}
