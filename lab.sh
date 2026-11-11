#!/usr/bin/env bash
# lab.sh — 一鍵部署 / 收起 / 清除　AI Agent 治理藍隊實驗環境
#
# 放在專案根目錄（與 docker-compose.yml 同層），執行前先給權限：chmod +x lab.sh
# 對目前的 ELK 版可直接用；之後換 Wazuh 版沿用同一支（會自動多做一次性憑證產生）。
#
#   ./lab.sh up        一鍵部署：起整套環境，資料保留在 named volume
#   ./lab.sh seed      匯入假資料、建立儀表板資料檢視（起來後跑一次）
#   ./lab.sh down      收起來：停掉容器、釋放 CPU/記憶體，但保留資料
#   ./lab.sh destroy   全部清除：連資料一起刪，回到乾淨狀態
#   ./lab.sh status    看目前各容器狀態
#   ./lab.sh logs      跟看日誌（Ctrl+C 離開）

set -euo pipefail
cd "$(dirname "$0")"
CMD="${1:-help}"

compose() { docker compose "$@"; }

# 一次性憑證產生：只有 Wazuh 版存在 generate-indexer-certs.yml，且憑證尚未產生時才跑。
# ELK 版沒有這個檔，整段自動略過，不影響。
ensure_certs() {
  [ -f generate-indexer-certs.yml ] || return 0
  if [ -n "$(ls -A config/wazuh_indexer_ssl_certs 2>/dev/null || true)" ]; then
    echo "[certs] 憑證已存在，略過產生"
  else
    echo "[certs] 第一次啟動，產生自簽憑證…"
    compose -f generate-indexer-certs.yml run --rm generator
  fi
}

# 預建空的治理事件檔，讓 Wazuh logcollector 一開機就開檔、從檔頭開始讀（搭配
# wazuh_manager.conf 的 <only-future-events>no</only-future-events>）。
# 若不預建：manager 先啟動、檔案稍後才由治理元件生成，logcollector 開機時開檔失敗，
# 會漏掉冷啟動後第一批事件（第一次實驗的告警可能為 0）。對 ELK 版為無害的多餘動作。
ensure_logs() {
  mkdir -p logs results
  for f in toolproxy-decisions agent-events sink-hits approvals actions soar-decisions; do
    [ -e "logs/$f.ndjson" ] || : > "logs/$f.ndjson"
  done
  # 入口網站與執行器之間的工作佇列（共享資料夾）
  for t in governed baseline; do
    mkdir -p "jobs/$t/pending" "jobs/$t/running" "jobs/$t/done"
  done
}

case "$CMD" in
  up)
    ensure_certs
    ensure_logs
    compose up -d --build
    echo
    echo "已啟動。接著："
    echo "  1) ./lab.sh status   確認容器 healthy"
    echo "  2) ./lab.sh seed     匯入假資料"
    ;;
  seed)
    compose run --rm seed
    ;;
  down)
    compose stop
    echo "已收起：容器停止、不佔 CPU/記憶體，資料保留。下次 ./lab.sh up 直接回到原狀。"
    ;;
  destroy)
    read -r -p "會刪除所有容器與資料（含 named volume），確定？輸入 yes 繼續： " ans
    if [ "$ans" = "yes" ]; then
      compose down -v --remove-orphans
      rm -rf logs results 2>/dev/null || sudo rm -rf logs results 2>/dev/null || true
      echo "已清除（含 logs/ 與 results/）。"
    else
      echo "已取消，未更動任何資料。"
    fi
    ;;
  status)
    compose ps
    ;;
  logs)
    compose logs -f --tail=50
    ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
