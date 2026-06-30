#!/bin/bash
# Deadman rollback for PATCH 17. No-ops if the marker was cleared (= healthy boot).
LOG=/root/ncl-p17.log
if [ ! -f /root/ncl-p17-pending ]; then echo "$(date -u) deadman: marker gone, no-op" >>$LOG; exit 0; fi
echo "$(date -u) deadman: FIRING rollback" >>$LOG
cd /root/nanoclaw-v2/src/channels || exit 1
for f in telegram-rich-message.ts telegram.ts chat-sdk-bridge.ts telegram-rich-message.test.ts chat-sdk-bridge.test.ts; do
  cp -f "$f.p17bak-20260627-221901" "$f"
done
cd /root/nanoclaw-v2 && pnpm build >>$LOG 2>&1 && systemctl restart nanoclaw-v2-454ebe7e.service
rm -f /root/ncl-p17-pending
echo "$(date -u) deadman: rollback done" >>$LOG
