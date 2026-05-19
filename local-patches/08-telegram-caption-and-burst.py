#!/usr/bin/env python3
"""Patch 08 — Telegram caption chunking + per-chat outbound queue.

Idempotent: detects if already applied and exits cleanly.

What it does:
  1) adds `maxCaptionLength?: number` to ChatSdkBridgeConfig
  2) adds module-level per-thread outbound queue (`enqueueOutbound`)
  3) makes the chunk-selection caption-aware (first chunk fits
     maxCaptionLength when files are attached, rest fits maxTextLength)
  4) wraps the deliver body in enqueueOutbound(tid, ...)
  5) wires `maxCaptionLength: 1000` in src/channels/telegram.ts

See 08-telegram-caption-and-burst.md for the full rationale.
"""
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "/root/nanoclaw-v2")
BRIDGE = ROOT / "src/channels/chat-sdk-bridge.ts"
TELEGRAM = ROOT / "src/channels/telegram.ts"


def patch(file: Path, transforms: list[dict]) -> None:
    s = file.read_text()
    changed = False
    for t in transforms:
        if t["marker"] in s:
            print(f"  skip {t['name']} (already applied)")
            continue
        if t["find"] not in s:
            raise SystemExit(
                f"{file}: anchor not found for {t['name']!r}. Source may have changed."
            )
        s = s.replace(t["find"], t["replace"])
        print(f"  apply {t['name']}")
        changed = True
    if changed:
        file.write_text(s)
        print(f"  wrote {file}")


print("=== chat-sdk-bridge.ts ===")
patch(
    BRIDGE,
    [
        {
            "name": "config interface: add maxCaptionLength",
            "marker": "maxCaptionLength?: number",
            "find": "  maxTextLength?: number;\n}\n\n/**",
            "replace": (
                "  maxTextLength?: number;\n"
                "  /**\n"
                "   * Maximum caption length when sending text + files together. Telegram's\n"
                "   * `sendDocument.caption` field is capped at 1024 chars by the upstream\n"
                "   * Telegram Bot API. Without this, captions longer than 1024 chars are\n"
                "   * silently truncated by Telegram itself — even when `maxTextLength` would\n"
                "   * otherwise split safely. The bridge uses this to size the first chunk\n"
                "   * (which rides as the caption) tighter than the rest.\n"
                "   */\n"
                "  maxCaptionLength?: number;\n"
                "}\n"
                "\n"
                "/**"
            ),
        },
        {
            "name": "outbound queue helpers",
            "marker": "enqueueOutbound",
            "find": "export function splitForLimit(text: string, limit: number): string[] {",
            "replace": (
                "/**\n"
                " * Per-thread outbound queue. When the agent emits multiple `<message>`\n"
                " * blocks in one response, the host fires separate `send_message` tool\n"
                " * calls that can run in parallel; Telegram's per-chat send rate (~1 msg/sec\n"
                " * sustained) then silently drops some sends. The queue serializes outbound\n"
                " * deliveries per chat without blocking other chats, with a small pacing\n"
                " * delay so consecutive sends fall under the rate cap.\n"
                " */\n"
                "const outboundQueues = new Map<string, Promise<unknown>>();\n"
                "const OUTBOUND_PACING_MS = 200;\n"
                "\n"
                "function enqueueOutbound<T>(tid: string, fn: () => Promise<T>): Promise<T> {\n"
                "  const prev = outboundQueues.get(tid) ?? Promise.resolve();\n"
                "  const next = prev\n"
                "    .then(() => new Promise<void>((r) => setTimeout(r, OUTBOUND_PACING_MS)))\n"
                "    .then(fn);\n"
                "  // Swallow rejection in the chain so subsequent enqueues still proceed,\n"
                "  // but the returned promise still rejects for the caller.\n"
                "  outboundQueues.set(tid, next.catch(() => {}));\n"
                "  return next;\n"
                "}\n"
                "\n"
                "export function splitForLimit(text: string, limit: number): string[] {"
            ),
        },
        {
            "name": "caption-aware chunk selection",
            "marker": "PATCH 08: caption-aware chunking",
            "find": (
                "        // Split if over the adapter's max length. Files ride on the first\n"
                "        // chunk so the head of the reply still carries them.\n"
                "        const chunks =\n"
                "          config.maxTextLength && text.length > config.maxTextLength\n"
                "            ? splitForLimit(text, config.maxTextLength)\n"
                "            : [text];"
            ),
            "replace": (
                "        // PATCH 08: caption-aware chunking. When files are attached, the\n"
                "        // first chunk rides as a file caption (Telegram sendDocument.caption:\n"
                "        // 1024 char limit), which is tighter than the regular sendMessage.text\n"
                "        // limit (4096). Use maxCaptionLength for the first chunk when files\n"
                "        // are present, maxTextLength for the rest.\n"
                "        const hasFiles = !!fileUploads && fileUploads.length > 0;\n"
                "        const firstChunkLimit =\n"
                "          hasFiles && config.maxCaptionLength\n"
                "            ? config.maxCaptionLength\n"
                "            : config.maxTextLength;\n"
                "        const restChunkLimit = config.maxTextLength;\n"
                "        let chunks: string[];\n"
                "        if (firstChunkLimit && text.length > firstChunkLimit) {\n"
                "          const head = splitForLimit(text, firstChunkLimit)[0];\n"
                "          const tail = text.slice(head.length).replace(/^\\s+/, '');\n"
                "          const tailChunks = tail\n"
                "            ? restChunkLimit && tail.length > restChunkLimit\n"
                "              ? splitForLimit(tail, restChunkLimit)\n"
                "              : [tail]\n"
                "            : [];\n"
                "          chunks = [head, ...tailChunks];\n"
                "        } else {\n"
                "          chunks = [text];\n"
                "        }"
            ),
        },
        {
            "name": "wrap deliver body with enqueueOutbound",
            "marker": "return enqueueOutbound(tid",
            "find": (
                '    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {\n'
                '      // platformId is already in the adapter\'s encoded format (e.g. "telegram:6037840640",\n'
                '      // "discord:guildId:channelId") — use it directly as the thread ID\n'
                "      const tid = threadId ?? platformId;\n"
                "      const content = message.content as Record<string, unknown>;"
            ),
            "replace": (
                '    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {\n'
                '      // platformId is already in the adapter\'s encoded format (e.g. "telegram:6037840640",\n'
                '      // "discord:guildId:channelId") — use it directly as the thread ID\n'
                "      const tid = threadId ?? platformId;\n"
                "      // PATCH 08: serialize outbound per-thread to avoid Telegram's per-chat\n"
                "      // rate limit silently dropping bursts when the agent emits multiple\n"
                "      // messages in one response.\n"
                "      return enqueueOutbound(tid, async () => {\n"
                "      const content = message.content as Record<string, unknown>;"
            ),
        },
    ],
)

# Close-deliver wrapper (must follow wrap-deliver — anchors after the new opening block)
bridge_text = BRIDGE.read_text()
if "PATCH08_CLOSE_DELIVER" in bridge_text:
    print("  skip close-deliver-wrapper (already applied)")
else:
    find_end = "    },\n\n    async setTyping(platformId: string, threadId: string | null) {"
    if find_end not in bridge_text:
        raise SystemExit("close-deliver anchor not found")
    bridge_text = bridge_text.replace(
        find_end,
        "      }); // PATCH08_CLOSE_DELIVER — end enqueueOutbound wrapper\n"
        "    },\n"
        "\n"
        "    async setTyping(platformId: string, threadId: string | null) {",
    )
    BRIDGE.write_text(bridge_text)
    print("  apply close-deliver-wrapper")

print("=== telegram.ts ===")
patch(
    TELEGRAM,
    [
        {
            "name": "wire maxCaptionLength: 1000",
            "marker": "maxCaptionLength: 1000",
            "find": "      maxTextLength: 4000,",
            "replace": (
                "      maxTextLength: 4000,\n"
                "      maxCaptionLength: 1000,  // PATCH 08: Telegram sendDocument.caption hard limit is 1024, leave 24-char safety buffer"
            ),
        },
    ],
)

print("done.")
