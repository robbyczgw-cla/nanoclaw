#!/bin/bash
# Apply PATCH 17: arm deadman, restart, health-check, self-disarm on healthy boot.
SVC=nanoclaw-v2-454ebe7e.service
LOG=/root/ncl-p17.log
echo "=== $(date -u) apply-17 start ===" | tee -a $LOG
touch /root/ncl-p17-pending
systemctl stop ncl-p17-deadman.timer 2>/dev/null
systemd-run --on-active=300 --unit=ncl-p17-deadman bash /root/nanoclaw-v2/local-patches/p17-rollback.sh
echo "deadman armed (rollback in 300s unless disarmed)" | tee -a $LOG
systemctl restart $SVC
echo "service restarted, waiting 30s for stable boot..." | tee -a $LOG
sleep 30
T1=$(systemctl show $SVC -p ActiveEnterTimestamp --value)
sleep 8
if systemctl is-active --quiet $SVC; then
  T2=$(systemctl show $SVC -p ActiveEnterTimestamp --value)
  if [ "$T1" = "$T2" ]; then
    rm -f /root/ncl-p17-pending
    systemctl stop ncl-p17-deadman.timer 2>/dev/null
    echo "✅ HEALTHY + STABLE (active since $T2, no re-boot). Deadman DISARMED. PATCH 17 live." | tee -a $LOG
    exit 0
  fi
  echo "⚠️ active but RE-BOOTED ($T1 -> $T2) = crash-loop. Leaving deadman armed to roll back." | tee -a $LOG
  exit 1
fi
echo "❌ NOT active after restart. Deadman will roll back in <5min." | tee -a $LOG
exit 1
