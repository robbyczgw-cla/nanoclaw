/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Pairing success! I'm spinning up the agent now, you'll get a message from them shortly.",
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

/**
 * PATCH 05 (local) — Resilient outbound Telegram send.
 *
 * Telegram silently DROPS messages when a formatted (Markdown) send is rejected
 * — e.g. HTTP 400 "can't parse entities" on markdown the legacy-V1 sanitizer
 * missed (stray underscore in a path, nested formatting, unbalanced backtick).
 * The @chat-adapter/telegram adapter correctly THROWS a typed error, but the
 * rejection propagates to an unlogged call site and the message vanishes with no
 * trace (confirmed: zero send errors in the journal despite repeated drops).
 *
 * This wraps the adapter's postMessage so it is resilient:
 *   1. 429 rate-limit            -> wait `retry_after` then retry once
 *   2. any other failure w/ text -> retry once as PLAIN text (markdown stripped),
 *                                   so the message ALWAYS arrives (worst case
 *                                   unformatted) instead of disappearing
 *   3. every failure is logged   -> a drop is never silent again
 *
 * This is the minimal/low-risk fix. The clean long-term fix is bumping
 * @chat-adapter/telegram to >=4.30 (legacy "Markdown" -> escaped "MarkdownV2")
 * and dropping sanitizeTelegramLegacyMarkdown; remove this wrapper then.
 */
function makeResilientTelegramSend<A extends { postMessage: (...args: any[]) => Promise<any> }>(adapter: A): A {
  const origPost = adapter.postMessage.bind(adapter) as (tid: string, m: any) => Promise<any>;
  const stripMarkdown = (s: string): string => s.replace(/[*_`[\]]/g, '');
  const isRateLimit = (e: unknown): boolean => {
    const any = e as { name?: string; message?: string };
    return (
      any?.name === 'AdapterRateLimitError' || /\b429\b|too many requests|rate.?limit/i.test(String(any?.message ?? ''))
    );
  };
  const retryAfterMs = (e: unknown): number => {
    const any = e as { retryAfter?: number; parameters?: { retry_after?: number } };
    return Math.max(1, Number(any?.retryAfter ?? any?.parameters?.retry_after ?? 1)) * 1000;
  };
  const errText = (e: unknown): string => String((e as { message?: string })?.message ?? e);
  adapter.postMessage = (async (tid: string, message: any): Promise<any> => {
    try {
      return await origPost(tid, message);
    } catch (err: unknown) {
      let last = err;
      if (isRateLimit(err)) {
        const waitMs = retryAfterMs(err) + 250;
        log.warn('Telegram 429 — waiting then retrying once', { tid, waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
        try {
          return await origPost(tid, message);
        } catch (e2: unknown) {
          last = e2;
        }
      }
      const msg = message as { markdown?: unknown };
      const md = typeof msg?.markdown === 'string' ? msg.markdown : '';
      if (md.length > 0) {
        log.error('Telegram formatted send failed — retrying as plain text', { tid, err: errText(last) });
        try {
          return await origPost(tid, { ...(message as object), markdown: stripMarkdown(md) });
        } catch (e3: unknown) {
          log.error('Telegram plain-text fallback ALSO failed — message dropped', { tid, err: errText(e3) });
          throw e3;
        }
      }
      log.error('Telegram send failed (no text to downgrade) — message dropped', { tid, err: errText(last) });
      throw last;
    }
  }) as A['postMessage'];
  return adapter;
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = makeResilientTelegramSend(
      createTelegramAdapter({
        botToken: token,
        mode: 'polling',
      }),
    );
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
      maxCaptionLength: 1000, // PATCH 08: Telegram sendDocument.caption hard limit is 1024, leave 24-char safety buffer
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
