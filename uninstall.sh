#!/usr/bin/env bash
# =============================================================================
# uninstall.sh — AI Agent 治理藍隊環境 解除安裝 / 清除工具
#
#   1) 收起（停容器、留全部資料）           = ./lab.sh down
#   2) Soft 清除（停+刪容器與本專案映像，留資料卷）
#   3) Full 清除（連資料卷、logs、results 一起刪，回到乾淨狀態）
#   4) 連同設定也刪（在 Full 之上，再刪 .env 與自簽憑證）
#
# 只動本專案（compose 專案名 agentlab-wz）的容器／映像／資料卷，不碰系統其他 Docker 資源。
# 不會移除 Docker 本身，也不會動到你另外安裝的 Ollama。
#
# 用法：
#   ./uninstall.sh            互動選單
#   ./uninstall.sh --down     直接收起
#   ./uninstall.sh --soft     直接 soft 清除
#   ./uninstall.sh --full     直接 full 清除（含確認）
#   ./uninstall.sh --purge    full + 刪 .env 與憑證（含確認）
#   ./uninstall.sh --yes ...  略過確認
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"

PROJECT="agentlab-wz"          # docker-compose.wazuh.yml 的 name:
ASSUME_YES=0; ACTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --down) ACTION="down" ;;
    --soft) ACTION="soft" ;;
    --full) ACTION="full" ;;
    --purge) ACTION="purge" ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知參數：$1（--help 看用法）"; exit 1 ;;
  esac
  shift
done
[ -t 1 ] || true
c_g='\e[1;32m'; c_b='\e[1;34m'; c_y='\e[1;33m'; c_r='\e[1;31m'; c_c='\e[1;36m'; c_0='\e[0m'
info(){ echo -e "${c_b}[資訊]${c_0} $*"; }
ok(){ echo -e "${c_g}[完成]${c_0} $*"; }
warn(){ echo -e "${c_y}[注意]${c_0} $*"; }
confirm(){ # $1 提示；--yes 直接通過
  [ "$ASSUME_YES" = 1 ] && return 0
  local ans; read -r -p "$(echo -e "${c_r}$1 輸入 yes 繼續：${c_0}")" ans || true
  [ "$ans" = "yes" ]
}
banner(){ echo -e "${c_c}\n   AI Agent 治理藍隊環境 — 解除安裝 / 清除\n${c_0}"; }

# 本專案的容器 / 映像 / 資料卷（只挑本專案，避免誤刪）
proj_containers(){ docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}'; }
proj_volumes(){ docker volume ls --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Name}}'; }
built_images(){ docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^${PROJECT}-" || true; }

do_down(){
  info "停止容器（保留資料）…"
  ./lab.sh down 2>/dev/null || docker compose stop 2>/dev/null || true
  ok "已收起。資料保留，下次 ./lab.sh up 或 ./install.sh 可回到原狀。"
}

do_soft(){
  info "停止並移除本專案容器與網路…"
  docker compose down --remove-orphans 2>/dev/null || true
  # 保險：若 compose 讀不到（.env 沒設 COMPOSE_FILE），用 label 兜底
  proj_containers | xargs -r docker rm -f 2>/dev/null || true
  info "移除本專案自建映像（${PROJECT}-*）…"
  built_images | xargs -r docker rmi -f 2>/dev/null || true
  ok "Soft 清除完成：容器與自建映像已移除，資料卷保留。"
  info "（官方映像 wazuh/grafana/postgres/nginx 仍保留，下次啟動免再下載。）"
}

do_full(){
  echo -e "${c_r}Full 清除會刪除：本專案所有容器、資料卷（含 Wazuh 告警與資料庫）、logs/、results/。${c_0}"
  confirm "確定要 Full 清除嗎？" || { info "已取消。"; return; }
  info "移除容器、資料卷、網路…"
  docker compose down -v --remove-orphans 2>/dev/null || true
  proj_containers | xargs -r docker rm -f 2>/dev/null || true
  proj_volumes | xargs -r docker volume rm -f 2>/dev/null || true
  info "移除本專案自建映像…"
  built_images | xargs -r docker rmi -f 2>/dev/null || true
  rm -rf logs results jobs 2>/dev/null || sudo rm -rf logs results jobs 2>/dev/null || true
  ok "Full 清除完成：回到乾淨狀態（設定 .env 與憑證仍保留）。"
}

do_purge(){
  do_full
  echo -e "${c_r}再刪除設定檔 .env 與自簽憑證（config/wazuh_indexer_ssl_certs/）。${c_0}"
  confirm "確定連設定與憑證也刪？" || { info "保留設定與憑證。"; return; }
  rm -f .env .host_ip 2>/dev/null || true
  find config/wazuh_indexer_ssl_certs -type f ! -name '.gitkeep' -delete 2>/dev/null || true
  ok "已刪除 .env 與憑證。下次要重裝請重跑 ./install.sh。"
}

banner
if [ -z "$ACTION" ]; then
  echo -e "${c_y}請選擇要做什麼：${c_0}"
  echo -e "  ${c_c}1)${c_0} 收起（停容器、留全部資料）"
  echo -e "  ${c_c}2)${c_0} Soft 清除（刪容器與自建映像，留資料卷）"
  echo -e "  ${c_c}3)${c_0} Full 清除（連資料卷、logs、results 一起刪）"
  echo -e "  ${c_c}4)${c_0} 連設定一起刪（Full ＋ .env ＋ 憑證）"
  echo -e "  ${c_c}5)${c_0} 離開"
  read -r -p "$(echo -e "${c_y}輸入 1-5：${c_0}")" ACTION_NUM || true
  case "${ACTION_NUM:-5}" in 1) ACTION=down ;; 2) ACTION=soft ;; 3) ACTION=full ;; 4) ACTION=purge ;; *) echo "離開。"; exit 0 ;; esac
fi
case "$ACTION" in
  down) do_down ;; soft) do_soft ;; full) do_full ;; purge) do_purge ;;
  *) echo "未知動作：$ACTION"; exit 1 ;;
esac
echo
docker system df 2>/dev/null | head -4 || true
