import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';
import * as bridgeModule from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  function setupStubAdapter(): Adapter {
    return stubAdapter({
      name: 'slack',
      initialize: async () => {},
    } as unknown as Partial<Adapter>);
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    runMigrations(initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id').all() as Array<{
      thread_id: string;
    }>;
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions').all() as Array<{
      thread_id: string;
    }>;
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

describe('createChatSdkBridge.deliver — tool-vis edit coalescing (PATCH 09)', () => {
  // A tool-heavy turn emits many `_toolVis: true` previews. Without coalescing
  // each becomes its own Telegram editMessageText call, flooding the chat and
  // tripping flood-control. These pin: (1) the first preview posts a fresh
  // bubble, (2) rapid follow-ups within the throttle window do NOT each hit the
  // API — they coalesce into a single trailing flush, (3) the real answer
  // posts as a fresh notifying message, not an edit of the bubble.
  function captureBoth() {
    const post: Array<{ tid: string; m: { markdown?: string } }> = [];
    const edit: Array<{ tid: string; mid: string; m: { markdown?: string } }> = [];
    const postMessage = async (tid: string, m: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      post.push({ tid, m: m as { markdown?: string } });
      return { id: `m${post.length}`, threadId: tid, raw: {} };
    };
    const editMessage = async (tid: string, mid: string, m: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      edit.push({ tid, mid, m: m as { markdown?: string } });
      return { id: mid, threadId: tid, raw: {} };
    };
    return { post, edit, postMessage, editMessage };
  }

  it('coalesces a burst of previews into one edit and posts the answer fresh', async () => {
    vi.useFakeTimers();
    try {
      const { post, edit, postMessage, editMessage } = captureBoth();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage, editMessage }),
        supportsThreads: false,
        maxTextLength: 4000,
      });
      const tid = 'telegram:99';
      const send = async (content: Record<string, unknown>) => {
        const p = bridge.deliver(tid, null, { kind: 'chat-sdk', content });
        await vi.advanceTimersByTimeAsync(250); // drain the 200ms enqueue pacing
        return p;
      };

      // First preview → fresh bubble. Five more within the throttle window.
      await send({ text: '🔧 step 1', _toolVis: true });
      for (let i = 2; i <= 6; i++) await send({ text: `🔧 step ${i}`, _toolVis: true });

      // One fresh bubble; the follow-ups are coalesced (not yet flushed).
      expect(post).toHaveLength(1);
      expect(edit).toHaveLength(0);

      // Trailing flush fires once after the throttle window, with combined text.
      await vi.advanceTimersByTimeAsync(3000);
      expect(edit).toHaveLength(1);
      expect(edit[0].m.markdown).toContain('step 1');
      expect(edit[0].m.markdown).toContain('step 6');

      // The real answer arrives → a NEW notifying message, never an edit.
      await send({ text: 'here is the final answer' });
      expect(post).toHaveLength(2);
      expect(post[1].m.markdown).toContain('final answer');
      expect(edit).toHaveLength(1); // bubble was already clean; no extra edit
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the bubble on finalize when the answer interrupts the throttle window', async () => {
    vi.useFakeTimers();
    try {
      const { post, edit, postMessage, editMessage } = captureBoth();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage, editMessage }),
        supportsThreads: false,
        maxTextLength: 4000,
      });
      const tid = 'telegram:77';
      const send = async (content: Record<string, unknown>) => {
        const p = bridge.deliver(tid, null, { kind: 'chat-sdk', content });
        await vi.advanceTimersByTimeAsync(250);
        return p;
      };

      await send({ text: 'step A', _toolVis: true }); // fresh bubble
      await send({ text: 'step B', _toolVis: true }); // coalesced, timer pending

      // Answer arrives before the trailing timer fires: finalize must flush the
      // pending state (so the bubble shows step B) THEN post the answer fresh.
      await send({ text: 'the answer' });
      expect(edit).toHaveLength(1); // pending flush forced by finalize
      expect(edit[0].m.markdown).toContain('step B');
      expect(post).toHaveLength(2); // bubble + fresh answer
      expect(post[1].m.markdown).toContain('the answer');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createChatSdkBridge.deliver — tool-vis collapse to <details> fold (PATCH 17)', () => {
  // With collapseToolVis on, finalize edits the completed bubble into a single
  // collapsed <details> fold (summary visible, per-call timeline one tap away)
  // instead of leaving the expanded timeline. Default-off preserves PATCH 09.
  function captureBoth() {
    const post: Array<{ tid: string; m: { markdown?: string } }> = [];
    const edit: Array<{ tid: string; mid: string; m: { markdown?: string } }> = [];
    const postMessage = async (tid: string, m: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      post.push({ tid, m: m as { markdown?: string } });
      return { id: `m${post.length}`, threadId: tid, raw: {} };
    };
    const editMessage = async (tid: string, mid: string, m: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      edit.push({ tid, mid, m: m as { markdown?: string } });
      return { id: mid, threadId: tid, raw: {} };
    };
    return { post, edit, postMessage, editMessage };
  }

  it('collapses the bubble into a <details> fold when the answer arrives', async () => {
    vi.useFakeTimers();
    try {
      const { post, edit, postMessage, editMessage } = captureBoth();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage, editMessage }),
        supportsThreads: false,
        maxTextLength: 4000,
        collapseToolVis: true,
      });
      const tid = 'telegram:171';
      const send = async (content: Record<string, unknown>) => {
        const p = bridge.deliver(tid, null, { kind: 'chat-sdk', content });
        await vi.advanceTimersByTimeAsync(250);
        return p;
      };

      await send({ text: '🔧 step A', _toolVis: true }); // fresh bubble
      await send({ text: '🔧 step B', _toolVis: true }); // coalesced
      await send({ text: 'the answer' }); // finalize → collapse

      // Exactly one edit: the collapse fold (not an expanded flush).
      expect(edit).toHaveLength(1);
      const folded = edit[0].m.markdown ?? '';
      expect(folded).toContain('<details>');
      expect(folded).toContain('🔧 2 Tool-Calls — aufklappen');
      expect(folded).toContain('step A');
      expect(folded).toContain('step B');
      expect(folded.trimEnd().endsWith('</details>')).toBe(true);
      // Answer still posts as a fresh, notifying message below the fold.
      expect(post).toHaveLength(2);
      expect(post[1].m.markdown).toContain('the answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('default-off: leaves the expanded timeline (PATCH 09 behaviour preserved)', async () => {
    vi.useFakeTimers();
    try {
      const { edit, postMessage, editMessage } = captureBoth();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage, editMessage }),
        supportsThreads: false,
        maxTextLength: 4000,
      });
      const tid = 'telegram:172';
      const send = async (content: Record<string, unknown>) => {
        const p = bridge.deliver(tid, null, { kind: 'chat-sdk', content });
        await vi.advanceTimersByTimeAsync(250);
        return p;
      };
      await send({ text: '🔧 step A', _toolVis: true });
      await send({ text: '🔧 step B', _toolVis: true });
      await send({ text: 'the answer' });
      expect(edit).toHaveLength(1);
      expect(edit[0].m.markdown ?? '').not.toContain('<details>');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('toWellFormedText + surrogate-safe chunking (PATCH 23)', () => {
  it('REGRESSION: a preview line ending in half an emoji is sanitized, not sent raw', () => {
    // Real production shape (2026-07-07): tool-vis line ended "…open-loops • \ud83d"
    // → Telegram rejected the bubble AND, via the pre-send flush, every later
    // real message on that chat: "text must be encoded in UTF-8".
    const { toWellFormedText } = bridgeModule;
    const poisoned = '⚠️ 0 stale • 🔄 3 open-loops • \ud83d';
    const clean = toWellFormedText(poisoned);
    expect(clean).toBe('⚠️ 0 stale • 🔄 3 open-loops • �');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clean)).toBe(false);
  });

  it('leaves well-formed text byte-identical', () => {
    const { toWellFormedText } = bridgeModule;
    const s = 'normal 🤖 text with emoji 📊 and umlauts äöü';
    expect(toWellFormedText(s)).toBe(s);
  });

  it('splitForLimit hard cut never splits a surrogate pair', () => {
    // 29 chars then an emoji straddling the limit=30 boundary.
    const text = 'x'.repeat(29) + '📊'.repeat(10);
    const chunks = splitForLimit(text, 30);
    for (const c of chunks) {
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c)).toBe(false);
    }
    expect(chunks.join('')).toBe(text); // nothing lost
  });
});
