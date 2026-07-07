/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import http from 'http';

import {
  Chat,
  Card,
  CardText,
  Actions,
  Button,
  LinkButton,
  type CardChild,
  type Adapter,
  type ConcurrencyStrategy,
  type Message as ChatMessage,
} from 'chat';
import { log } from '../log.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import { getAskQuestionRender } from '../db/sessions.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { buildCollapsedToolVis } from './telegram-rich-message.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

/** Reply context extracted from a platform's raw message. */
export interface ReplyContext {
  text: string;
  sender: string;
}

/** Extract reply context from a platform-specific raw message. Return null if no reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReplyContextExtractor = (raw: Record<string, any>) => ReplyContext | null;

export interface ChatSdkBridgeConfig {
  adapter: Adapter;
  /**
   * Adapter-instance name for running multiple bridges of one platform
   * (e.g. several Slack apps in one workspace). Defaults to the platform
   * name. Drives the registry key, the webhook route (/webhook/<instance>),
   * and the Chat SDK state namespace. channelType is NOT affected — user
   * identity, formatting, and container config stay keyed on the platform.
   * Must be URL-safe: non-empty, only letters, digits, '.', '_' or '-'.
   */
  instance?: string;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Whether this platform uses threads as the primary conversation unit.
   * See `ChannelAdapter.supportsThreads`. Declared by the calling channel
   * skill, not inferred, because some platforms (Discord) can be used either
   * way and the default depends on installation style.
   */
  supportsThreads: boolean;
  /**
   * Optional transform applied to outbound text/markdown before it reaches the
   * adapter. Used by channels that need to sanitize for a platform-specific
   * quirk (e.g. Telegram's legacy Markdown parse mode).
   */
  transformOutboundText?: (text: string) => string;
  /**
   * Maximum text length the underlying adapter accepts in a single message.
   * When set, the bridge splits outbound text longer than this on paragraph
   * → line → hard-char boundaries and posts multiple messages. Without this,
   * adapters like Discord (2000) and Telegram (4096) silently truncate
   * mid-response. The returned id is the first chunk's id so subsequent edits
   * and reactions still target the head of the reply.
   */
  maxTextLength?: number;
  /**
   * Maximum caption length when sending text + files together. Telegram's
   * `sendDocument.caption` field is capped at 1024 chars by the upstream
   * Telegram Bot API. Without this, captions longer than 1024 chars are
   * silently truncated by Telegram itself — even when `maxTextLength` would
   * otherwise split safely. The bridge uses this to size the first chunk
   * (which rides as the caption) tighter than the rest.
   */
  maxCaptionLength?: number;
  /**
   * PATCH 17: when true, a finished turn collapses its tool-visibility bubble
   * into a `<details>` fold (one final edit) instead of leaving the full
   * per-tool-call timeline expanded. The summary stays visible; the timeline
   * hides behind a tap. Set only by adapters whose edit path renders `<details>`
   * natively (Telegram via Bot API 10.1 rich messages). Default off.
   */
  collapseToolVis?: boolean;
}

/**
 * Split `text` into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a hard character cut as a last resort.
 * Preserves code fences only structurally — a fenced block that straddles a
 * chunk boundary will render as two independent blocks on the receiving
 * platform, which is the same behavior as manually re-opening a fence.
 */
/**
 * Decode the actual option value from a button callback. Buttons are encoded
 * with an integer index (to keep under Telegram's 64-byte callback_data cap),
 * and the real value is looked up via `getAskQuestionRender(questionId)`.
 * Falls back to treating the tail as a literal value so old in-flight cards
 * (encoded before this shortening landed) still resolve.
 */
function resolveSelectedOption(
  render: { options: NormalizedOption[] } | undefined,
  eventValue: string | undefined,
  tail: string | undefined,
): string {
  const candidate = eventValue ?? tail ?? '';
  if (render && /^\d+$/.test(candidate)) {
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
  }
  return candidate;
}

/**
 * Per-thread outbound queue. When the agent emits multiple `<message>`
 * blocks in one response, the host fires separate `send_message` tool
 * calls that can run in parallel; Telegram's per-chat send rate (~1 msg/sec
 * sustained) then silently drops some sends. The queue serializes outbound
 * deliveries per chat without blocking other chats, with a small pacing
 * delay so consecutive sends fall under the rate cap.
 */
const outboundQueues = new Map<string, Promise<unknown>>();
const OUTBOUND_PACING_MS = 200;

// PATCH 09: tool-visibility edit coalescing. A tool-heavy turn emits dozens of
// `tv-*` previews; without throttling each becomes its own Telegram
// editMessageText call, flooding the chat (measured 211 tv-edits vs 72 real
// messages in 30 min) and tripping Telegram flood-control — which buries the
// real reply. We coalesce: rapid previews update the bubble text in memory and
// flush to Telegram at most once per window (leading edit + trailing flush),
// cutting dozens of API calls to a handful. The bubble is force-flushed when
// the real answer arrives so it shows its final state before the fresh,
// notifying reply posts below it.
const TOOL_VIS_EDIT_THROTTLE_MS = 2500;

function enqueueOutbound<T>(tid: string, fn: () => Promise<T>): Promise<T> {
  const prev = outboundQueues.get(tid) ?? Promise.resolve();
  const next = prev.then(() => new Promise<void>((r) => setTimeout(r, OUTBOUND_PACING_MS))).then(fn);
  // Swallow rejection in the chain so subsequent enqueues still proceed,
  // but the returned promise still rejects for the caller.
  outboundQueues.set(
    tid,
    next.catch(() => {}),
  );
  return next;
}

/**
 * PATCH 23: replace lone UTF-16 surrogates (an emoji cut in half by some
 * upstream truncation) with U+FFFD. A lone surrogate is invalid UTF-8 on the
 * wire — Telegram rejects the send ("text must be encoded in UTF-8"),
 * including the plain-text fallback, so the message is dropped entirely.
 * (Node 22 has String.prototype.toWellFormed; typed via a cast because the
 * tsconfig lib predates ES2024. Regex fallback covers exotic runtimes.)
 */
export function toWellFormedText(t: string): string {
  const fn = (t as unknown as { toWellFormed?: () => string }).toWellFormed;
  return typeof fn === 'function'
    ? fn.call(t)
    : t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    // PATCH 23: a hard cut must not land between the halves of a surrogate
    // pair — back off one unit so the emoji moves whole into the next chunk.
    const before = remaining.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

interface ToolVisAccumulator {
  messageId: string;
  lines: string[];
  combinedLength: number;
  // PATCH 09 edit-coalescing state:
  lastEditAt: number; // timestamp of the last editMessage actually sent
  pendingTimer: ReturnType<typeof setTimeout> | null; // trailing-flush timer
  dirty: boolean; // in-memory lines changed since the last flush
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  // In-memory map of open tool-visibility accumulators. Keyed by `${tid}:tool-vis`.
  // Each entry tracks the original message_id + accumulated lines so we can
  // edit-in-place rather than emit a new message per tool call.
  // Cleared on the next non-tool-vis message to that thread (the agent's
  // actual answer flushes the accumulator).
  const toolVisAccumulators = new Map<string, ToolVisAccumulator>();

  // PATCH 09: Push the accumulator's current in-memory text to Telegram as a
  // single editMessage. The actual coalescing happens in
  // deliverToolVisAccumulator (which decides whether to flush now or defer);
  // this just performs the edit and clears the dirty flag. Falls back to a
  // fresh send if the edit fails (message gone, etc.). No-op when the
  // accumulator is missing (already finalized) or not dirty (nothing new).
  // The caller is responsible for serialization (it runs inside enqueueOutbound
  // for inline flushes; the trailing-flush timer wraps it in enqueueOutbound).
  async function flushToolVis(tid: string, accumKey: string): Promise<void> {
    const acc = toolVisAccumulators.get(accumKey);
    if (!acc || !acc.dirty) return;
    const combined = transformText(acc.lines.join('\n'));
    try {
      await adapter.editMessage(tid, acc.messageId, { markdown: combined });
      acc.dirty = false;
      acc.lastEditAt = Date.now();
    } catch (err) {
      // Edit failed — rate-limit, message-deleted, adapter without edit
      // support, or unchanged-content. Re-post the full combined text fresh so
      // the visible bubble still carries everything accumulated so far.
      log.warn('Tool-vis edit failed, falling back to fresh send', {
        err: err instanceof Error ? err.message : String(err),
        adapter: adapter.name,
      });
      const result = await adapter.postMessage(tid, { markdown: combined });
      const id = result?.id;
      if (id) {
        acc.messageId = id;
        acc.dirty = false;
        acc.lastEditAt = Date.now();
      }
    }
  }

  // Send a tool-visibility line into an accumulator. First line for a key
  // creates a new message; subsequent lines update that message in-place —
  // but COALESCED (PATCH 09): rapid previews only mutate the in-memory text and
  // are flushed to Telegram at most once per TOOL_VIS_EDIT_THROTTLE_MS via a
  // leading edit plus a trailing-flush timer, so dozens of tool calls cost a
  // handful of API calls instead of dozens.
  async function deliverToolVisAccumulator(
    tid: string,
    lineText: string,
    accumKey: string,
  ): Promise<string | undefined> {
    const transformed = transformText(lineText);
    const existing = toolVisAccumulators.get(accumKey);

    if (!existing) {
      // First emit for this accumulator — send fresh and remember the id.
      const result = await adapter.postMessage(tid, { markdown: transformed });
      const id = result?.id;
      if (id) {
        toolVisAccumulators.set(accumKey, {
          messageId: id,
          lines: [lineText],
          combinedLength: lineText.length,
          lastEditAt: Date.now(),
          pendingTimer: null,
          dirty: false,
        });
      }
      return id;
    }

    // Length guard — if the next line would push past the adapter's limit,
    // flush the current bubble's pending text, then start a fresh bubble rather
    // than truncating mid-call.
    const projected = existing.combinedLength + 1 + lineText.length;
    if (config.maxTextLength && projected > config.maxTextLength) {
      if (existing.pendingTimer) {
        clearTimeout(existing.pendingTimer);
        existing.pendingTimer = null;
      }
      await flushToolVis(tid, accumKey);
      const result = await adapter.postMessage(tid, { markdown: transformed });
      const id = result?.id;
      if (id) {
        toolVisAccumulators.set(accumKey, {
          messageId: id,
          lines: [lineText],
          combinedLength: lineText.length,
          lastEditAt: Date.now(),
          pendingTimer: null,
          dirty: false,
        });
      }
      return id;
    }

    // Accumulate the line in memory and mark dirty.
    existing.lines.push(lineText);
    existing.combinedLength = existing.lines.join('\n').length;
    existing.dirty = true;

    const sinceLast = Date.now() - existing.lastEditAt;
    if (sinceLast >= TOOL_VIS_EDIT_THROTTLE_MS) {
      // Enough time has passed — flush now (leading edge). Cancel any pending
      // trailing timer; this flush subsumes it.
      if (existing.pendingTimer) {
        clearTimeout(existing.pendingTimer);
        existing.pendingTimer = null;
      }
      await flushToolVis(tid, accumKey);
    } else if (!existing.pendingTimer) {
      // Within the throttle window — schedule a single trailing flush that
      // ships whatever has accumulated by the time it fires. Wrapped in
      // enqueueOutbound so it serializes with other sends to this thread.
      const delay = TOOL_VIS_EDIT_THROTTLE_MS - sinceLast;
      existing.pendingTimer = setTimeout(() => {
        const acc = toolVisAccumulators.get(accumKey);
        if (acc) acc.pendingTimer = null;
        void enqueueOutbound(tid, () => flushToolVis(tid, accumKey)).catch(() => {});
      }, delay);
    }
    // else: a trailing flush is already scheduled; this line rides along.
    return existing.messageId;
  }

  // PATCH 09: finalize an open tool-vis bubble — cancel its pending trailing
  // flush and push its final state synchronously, so the bubble is complete
  // before the real answer posts as a fresh, notifying message below it.
  async function finalizeToolVis(tid: string, accumKey: string): Promise<void> {
    const acc = toolVisAccumulators.get(accumKey);
    if (!acc) return;
    if (acc.pendingTimer) {
      clearTimeout(acc.pendingTimer);
      acc.pendingTimer = null;
    }
    // PATCH 17: collapse the completed timeline into a <details> fold via one
    // final edit, so the chat keeps only a compact "🔧 N Tool-Calls — aufklappen"
    // summary with the per-call detail one tap away. The adapter's edit path
    // routes <details> through the rich (Bot API 10.1) path; if that or the edit
    // fails, fall back to the plain final flush so the bubble is never lost.
    if (config.collapseToolVis && acc.lines.length > 0) {
      const folded = buildCollapsedToolVis(acc.lines);
      if (folded) {
        try {
          await adapter.editMessage(tid, acc.messageId, { markdown: folded });
          acc.dirty = false;
          toolVisAccumulators.delete(accumKey);
          return;
        } catch (err) {
          log.warn('Tool-vis collapse edit failed — falling back to expanded flush', {
            err: err instanceof Error ? err.message : String(err),
            adapter: adapter.name,
          });
        }
      }
    }
    await flushToolVis(tid, accumKey);
    toolVisAccumulators.delete(accumKey);
  }

  const { adapter } = config;
  // The instance name becomes a webhook route segment (the route regex is
  // [^/?]+) and ':' is the state-namespace delimiter — reject anything that
  // would break either, at construction time rather than at first webhook.
  // Positive allow-list (not a deny-list): also rejects '' and
  // whitespace-only names, which are config bugs — '' is falsy, so it
  // would skip a truthiness guard, dead-end the webhook route, and
  // collapse the state namespace into the default instance's keyspace.
  if (config.instance !== undefined && !/^[A-Za-z0-9._-]+$/.test(config.instance)) {
    throw new Error(
      `chat-sdk bridge instance ${JSON.stringify(config.instance)} must be URL-safe: ` +
        `non-empty, only letters, digits, '.', '_' or '-'`,
    );
  }
  // PATCH 23: sanitize lone UTF-16 surrogates (e.g. an emoji cut in half by a
  // preview truncation) at the single outbound choke point. One poisoned
  // string otherwise makes the platform API reject with "text must be encoded
  // in UTF-8" — including the plain-text fallback, so the message (and, via
  // the pre-send tool-vis flush, EVERY later message on that chat) is dropped
  // until a host restart.
  const transformText = (t: string): string =>
    toWellFormedText(config.transformOutboundText ? config.transformOutboundText(t) : t);
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  let gatewayAbort: AbortController | null = null;

  async function messageToInbound(
    message: ChatMessage,
    isMention: boolean,
    isGroup?: boolean,
  ): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData()
    if (message.attachments && message.attachments.length > 0) {
      const enriched = [];
      for (const att of message.attachments) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry: Record<string, any> = {
          type: att.type,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          width: (att as unknown as Record<string, unknown>).width,
          height: (att as unknown as Record<string, unknown>).height,
        };
        if (att.fetchData) {
          try {
            const buffer = await att.fetchData();
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment', { type: att.type, err });
          }
        }
        enriched.push(entry);
      }
      serialized.attachments = enriched;
    }

    // Extract reply context via platform-specific hook
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) serialized.replyTo = replyTo;
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as { userId?: string; fullName?: string; userName?: string } | undefined;
    if (author) {
      const name = author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
    }

    // Drop raw to save DB space (can be very large)
    serialized.raw = undefined;

    return {
      id: message.id,
      kind: 'chat-sdk',
      content: serialized,
      timestamp: message.metadata.dateSent.toISOString(),
      isMention,
      isGroup,
    };
  }

  const bridge: ChannelAdapter = {
    name: config.instance ?? adapter.name,
    channelType: adapter.name, // unchanged — semantic platform key
    instance: config.instance, // undefined ⇒ default instance

    supportsThreads: config.supportsThreads,

    async setup(hostConfig: ChannelSetup) {
      setupConfig = hostConfig;

      // State namespace: ONLY for a named non-default instance. A skill
      // that explicitly names the primary instance after the platform
      // (instance === adapter.name) still lands on the legacy UNPREFIXED
      // keyspace — prefixing the default would orphan every live install's
      // chat_sdk_subscriptions/kv/locks/lists rows.
      state = new SqliteStateAdapter(config.instance && config.instance !== adapter.name ? config.instance : undefined);

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: 'silent',
      });

      // Four SDK dispatch paths — bridge just forwards. All per-wiring
      // engage / accumulate / drop / subscribe decisions live in the host
      // router (src/router.ts routeInbound / evaluateEngage). The bridge
      // only resolves channel ids and sets the platform-confirmed isMention
      // flag that routeInbound evaluates; the router calls back into
      // bridge.subscribe(...) when a mention-sticky wiring engages.

      // Subscribed threads — every message in a thread we've previously
      // engaged. Carry the SDK's `message.isMention` through so mention-mode
      // wirings still fire on in-thread mentions.
      chat.onSubscribedMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(
          channelId,
          thread.id,
          await messageToInbound(message, message.isMention === true, true),
        );
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, true));
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // so sub-thread context reaches delivery (Slack users can open threads
      // inside a DM). Router collapses DM sub-threads to one session via
      // is_group=0 short-circuit.
      chat.onDirectMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId,
          sender: (message.author as any)?.fullName ?? (message.author as any)?.userId ?? 'unknown',
          threadId: thread.id,
        });
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, false));
      });

      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` lets the router see every plain message (including
      // media-only messages with empty text) on every unsubscribed thread the
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, false, true));
      });

      // Handle button clicks (ask_user_question)
      chat.onAction(async (event) => {
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const tail = parts.slice(2).join(':');
        const userId = event.user?.userId || '';

        // Resolve render metadata BEFORE dispatching onAction (which deletes the row).
        const render = getAskQuestionRender(questionId);
        // New format: button id/value is an integer index into options (kept
        // short to fit Telegram's 64-byte callback_data cap). Old format:
        // the full value is embedded in actionId/value directly.
        const selectedOption = resolveSelectedOption(render, event.value, tail);
        const title = render?.title ?? '❓ Question';
        const matched = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matched?.selectedLabel ?? selectedOption ?? '(clicked)';

        // Update the card to show the selected answer, who acted, and remove buttons
        const actorName = event.user?.userName || event.user?.fullName || '';
        const byLine = actorName ? ` — ${actorName}` : '';
        try {
          const tid = event.threadId;
          await adapter.editMessage(tid, event.messageId, {
            markdown: `${title}\n\n${selectedLabel}${byLine}`,
          });
        } catch (err) {
          log.warn('Failed to update card after action', { err });
        }

        setupConfig.onAction(questionId, selectedOption, userId);
      });

      await chat.initialize();

      // Start Gateway listener for adapters that support it (e.g., Discord)
      const gatewayAdapter = adapter as GatewayAdapter;
      if (gatewayAdapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken);

        // Exponential backoff capped at 1h. Without this, an unrecoverable
        // failure (e.g., TokenInvalid) restarts ~10×/sec and Discord's
        // Cloudflare layer issues a multi-hour IP block. A run that lasts
        // longer than 5 minutes counts as healthy and resets the counter.
        let consecutiveFailures = 0;
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          const startedAt = Date.now();
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          gatewayAdapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          ).then(() => {
            // startGatewayListener resolves immediately with a Response;
            // the actual work is in the listenerPromise passed to waitUntil
            if (!listenerPromise) return;
            const reschedule = (err?: unknown) => {
              if (gatewayAbort?.signal.aborted) return;
              const ranForMs = Date.now() - startedAt;
              if (ranForMs > 5 * 60 * 1000) consecutiveFailures = 0;
              else consecutiveFailures++;
              const delayMs = Math.min(60 * 60 * 1000, 2 ** consecutiveFailures * 1000);
              if (err) {
                log.error('Gateway listener error, retrying', {
                  adapter: adapter.name,
                  err,
                  consecutiveFailures,
                  delayMs,
                });
              } else {
                log.info('Gateway listener expired, restarting', {
                  adapter: adapter.name,
                  consecutiveFailures,
                  delayMs,
                });
              }
              setTimeout(startGateway, delayMs);
            };
            listenerPromise.then(() => reschedule()).catch(reschedule);
          });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      } else {
        // Non-gateway adapters (Slack, Teams, GitHub, etc.) — register on the
        // shared webhook server. The handler key stays adapter.name (the
        // Chat instance's webhooks map is keyed by it); the route segment is
        // the instance, so each same-platform bridge gets its own URL (and
        // its own signing secret — platforms sign per-app).
        registerWebhookAdapter(chat, adapter.name, config.instance ?? adapter.name);
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      // PATCH 08: serialize outbound per-thread to avoid Telegram's per-chat
      // rate limit silently dropping bursts when the agent emits multiple
      // messages in one response.
      return enqueueOutbound(tid, async () => {
        const content = message.content as Record<string, unknown>;

        // ── Tool-visibility accumulator ──────────────────────────────────
        // Tool-call previews carry `_toolVis: true` (set by the agent
        // container's tool-visibility hook). We accumulate these into a
        // single message-bubble per thread by editing the original send
        // rather than emitting a new notification per tool call.
        const accumKey = `${tid}:tool-vis`;
        if (content._toolVis === true) {
          const lineText = (content.text as string) || '';
          if (!lineText) return;
          return await deliverToolVisAccumulator(tid, lineText, accumKey);
        }
        // Non-tool-vis message → finalize any open tool-vis bubble (flush its
        // pending coalesced state, PATCH 09) so the agent's actual answer
        // renders as a separate, fresh, notifying bubble below the completed
        // tool-vis timeline.
        // PATCH 23: never let a broken tool-vis bubble block the real reply —
        // finalize failures are logged and the bubble dropped, not propagated
        // (a propagated throw was attributed to the real message by delivery
        // retry, permanently dropping every reply on this chat).
        try {
          await finalizeToolVis(tid, accumKey);
        } catch (err) {
          log.warn('Tool-vis finalize failed — dropping bubble, continuing with real message', {
            tid,
            err: String((err as { message?: string })?.message ?? err),
          });
          toolVisAccumulators.delete(accumKey);
        }

        if (content.operation === 'edit' && content.messageId) {
          await adapter.editMessage(tid, content.messageId as string, {
            markdown: transformText((content.text as string) || (content.markdown as string) || ''),
          });
          return;
        }

        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
          return;
        }

        // Ask question card — render as Card with buttons
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);
          const card = Card({
            title,
            children: [
              CardText(question),
              Actions(
                // Encode button id/value with the option index rather than the
                // full value. Telegram caps callback_data at 64 bytes, and
                // long values (e.g. ISO datetimes, URLs) push the JSON payload
                // well past that. The onAction handlers resolve the index back
                // to the real value via getAskQuestionRender(questionId).
                options.map((opt, idx) =>
                  Button({ id: `ncq:${questionId}:${idx}`, label: opt.label, value: String(idx) }),
                ),
              ),
            ],
          });
          const result = await adapter.postMessage(tid, {
            card,
            fallbackText: `${title}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`,
          });
          return result?.id;
        }

        // Display card (send_card MCP tool) — returns immediately, no callback flow.
        // Non-URL actions are dropped: send_card's contract is fire-and-forget, so a
        // callback button would have nowhere to land. URL actions render as link buttons.
        if (content.type === 'card' && content.card && typeof content.card === 'object') {
          const cardSpec = content.card as Record<string, unknown>;
          const title = (cardSpec.title as string) || '';
          const fallbackText = (content.fallbackText as string) || (cardSpec.description as string) || title || '';

          const cardChildren: CardChild[] = [];
          if (typeof cardSpec.description === 'string' && cardSpec.description) {
            cardChildren.push(CardText(cardSpec.description));
          }
          if (Array.isArray(cardSpec.children)) {
            for (const child of cardSpec.children) {
              if (typeof child === 'string' && child) {
                cardChildren.push(CardText(child));
              } else if (
                child &&
                typeof child === 'object' &&
                typeof (child as Record<string, unknown>).text === 'string'
              ) {
                cardChildren.push(CardText((child as Record<string, string>).text));
              }
            }
          }
          if (Array.isArray(cardSpec.actions)) {
            const linkButtons = (cardSpec.actions as Array<Record<string, unknown>>)
              .filter((a) => typeof a.url === 'string' && a.url && typeof a.label === 'string' && a.label)
              .map((a) => {
                const style = a.style;
                const safeStyle: 'primary' | 'danger' | 'default' | undefined =
                  style === 'primary' || style === 'danger' || style === 'default' ? style : undefined;
                return LinkButton({
                  label: a.label as string,
                  url: a.url as string,
                  style: safeStyle,
                });
              });
            if (linkButtons.length > 0) {
              cardChildren.push(Actions(linkButtons));
            }
          }

          if (cardChildren.length === 0 && !title) {
            log.warn('send_card payload empty, skipping delivery');
            return;
          }

          const card = Card({ title, children: cardChildren });
          const result = await adapter.postMessage(tid, { card, fallbackText });
          return result?.id;
        }

        // Normal message
        const rawText = (content.markdown as string) || (content.text as string);
        const text = rawText ? transformText(rawText) : rawText;
        if (text) {
          // Attach files if present (FileUpload format: { data, filename })
          const fileUploads = message.files?.map((f: { data: Buffer; filename: string }) => ({
            data: f.data,
            filename: f.filename,
          }));
          // PATCH 08: caption-aware chunking. When files are attached, the
          // first chunk rides as a file caption (Telegram sendDocument.caption:
          // 1024 char limit), which is tighter than the regular sendMessage.text
          // limit (4096). Use maxCaptionLength for the first chunk when files
          // are present, maxTextLength for the rest.
          const hasFiles = !!fileUploads && fileUploads.length > 0;
          const firstChunkLimit = hasFiles && config.maxCaptionLength ? config.maxCaptionLength : config.maxTextLength;
          const restChunkLimit = config.maxTextLength;
          let chunks: string[];
          if (firstChunkLimit && text.length > firstChunkLimit) {
            const head = splitForLimit(text, firstChunkLimit)[0];
            const tail = text.slice(head.length).replace(/^\s+/, '');
            const tailChunks = tail
              ? restChunkLimit && tail.length > restChunkLimit
                ? splitForLimit(tail, restChunkLimit)
                : [tail]
              : [];
            chunks = [head, ...tailChunks];
          } else {
            chunks = [text];
          }
          let firstId: string | undefined;
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const attachFiles = i === 0 && fileUploads && fileUploads.length > 0;
            const result = await adapter.postMessage(
              tid,
              attachFiles ? { markdown: chunk, files: fileUploads } : { markdown: chunk },
            );
            if (i === 0) firstId = result?.id;
          }
          return firstId;
        } else if (message.files && message.files.length > 0) {
          // Files only, no text
          const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
            data: f.data,
            filename: f.filename,
          }));
          const result = await adapter.postMessage(tid, { markdown: '', files: fileUploads });
          return result?.id;
        }
      }); // PATCH08_CLOSE_DELIVER — end enqueueOutbound wrapper
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid);
    },

    async teardown() {
      gatewayAbort?.abort();
      // PATCH 09: cancel any in-flight tool-vis trailing-flush timers so they
      // can't fire an edit after the Chat instance is torn down.
      for (const acc of toolVisAccumulators.values()) {
        if (acc.pendingTimer) clearTimeout(acc.pendingTimer);
      }
      toolVisAccumulators.clear();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      return true;
    },

    async subscribe(_platformId: string, threadId: string) {
      // Chat SDK's subscription state lives on the StateAdapter (not on the
      // Chat instance itself). SqliteStateAdapter.subscribe is idempotent —
      // a second call on an already-subscribed thread is a no-op. threadId
      // is the SDK's thread id, which is what the router already has from
      // the original inbound event.
      await state.subscribe(threadId);
    },
  };

  // Only expose openDM when the underlying Chat SDK adapter implements it.
  // Delegate straight to adapter.openDM rather than going through chat.openDM:
  // the latter dispatches via inferAdapterFromUserId, which only recognizes
  // Discord snowflakes, Slack U-ids, Teams 29:-ids, and gChat users/-ids, and
  // throws for everything else (Telegram numeric ids, iMessage, Matrix, …).
  // Calling adapter.openDM directly also preserves the adapter's native
  // platform_id encoding via channelIdFromThreadId (e.g. "telegram:<chatId>"),
  // which matches what onInbound stores in messaging_groups — avoiding a
  // duplicate-row / decode-error cascade at delivery time. See user-dm.ts for
  // the direct-addressable fallback when the adapter has no openDM at all.
  if (adapter.openDM) {
    bridge.openDM = async (userHandle: string): Promise<string> => {
      const threadId = await adapter.openDM!(userHandle);
      return adapter.channelIdFromThreadId(threadId);
    };
  }

  return bridge;
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 */
function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        handleForwardedEvent(body, adapter, setupConfig, botToken)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

async function handleForwardedEvent(
  body: string,
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      // In guilds the clicker is at interaction.member.user; in DMs it's interaction.user directly.
      const user =
        ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
        (interaction.user as Record<string, string> | undefined);
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;

      // Parse the selected option from custom_id
      let questionId: string | undefined;
      let tail: string | undefined;
      if (customId?.startsWith('ncq:')) {
        const colonIdx = customId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = customId.slice(4, colonIdx);
          tail = customId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds =
        ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      const render = questionId ? getAskQuestionRender(questionId) : undefined;
      // Discord custom_id mirrors the new index-based encoding (see Button
      // construction). Decode back to the real option value for downstream.
      const selectedOption = resolveSelectedOption(render, tail, tail);
      const cardTitle = render?.title ?? ((originalEmbeds[0]?.title as string) || '❓ Question');
      const matchedOpt = render?.options.find((o) => o.value === selectedOption);
      const selectedLabel = matchedOpt?.selectedLabel ?? selectedOption ?? customId;
      try {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 7, // UPDATE_MESSAGE — acknowledge + update in one call
            data: {
              embeds: [
                {
                  title: cardTitle,
                  description: `${originalDescription}\n\n${selectedLabel}`,
                },
              ],
              components: [], // remove buttons
            },
          }),
        });
      } catch (err) {
        log.error('Failed to update interaction', { err });
      }

      // Dispatch to host
      if (questionId && selectedOption) {
        setupConfig.onAction(questionId, selectedOption, user?.id || '');
      }
      return;
    }
  }

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
}
