#!/usr/bin/env bash
# =============================================================================
# install.sh — AI Agent 治理藍隊環境（Wazuh 版）一鍵安裝器
#
# 給「第一次拿到這包、不熟 Docker」的人用：執行這一支，依指示選擇即可。
# 安裝過程會問你兩個選擇：
#   (A) Docker：   1) 我已經裝好了（只檢查）   2) 還沒裝，請自動幫我裝
#   (B) 模型服務： 1) 我已有 Ollama／vLLM，指過去就好   2) 在這台機器裝 Ollama 並下載模型
# 其餘（偵測 IP、產生亂數憑證、設定 vm.max_map_count、佈署、匯入假資料、印出網址）全自動。
#
# 用法：
#   ./install.sh                         互動安裝（建議）
#   ./install.sh --yes                   不互動，全用預設（Docker=已安裝、Ollama=指定現有）
#   ./install.sh --docker install        指定：自動安裝 Docker
#   ./install.sh --docker have           指定：已安裝 Docker（只檢查）
#   ./install.sh --ollama install        指定：在本機安裝 Ollama 並拉模型
#   ./install.sh --ollama point          指定：指向現有模型服務
#   ./install.sh --model gemma4:31b --model-url http://192.168.1.50:11434
#
# 解除安裝 / 收起：見 ./uninstall.sh 與 ./lab.sh down / destroy
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

# ---------- 參數 ----------
ASSUME_YES=0
OPT_DOCKER=""      # have | install
OPT_OLLAMA=""      # point | install
OPT_MODEL=""
OPT_MODEL_URL=""
USE_COLOR=1
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --docker) OPT_DOCKER="${2:-}"; shift ;;
    --ollama) OPT_OLLAMA="${2:-}"; shift ;;
    --model) OPT_MODEL="${2:-}"; shift ;;
    --model-url) OPT_MODEL_URL="${2:-}"; shift ;;
    --no-color) USE_COLOR=0 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知參數：$1（--help 看用法）"; exit 1 ;;
  esac
  shift
done
# 非終端機（例如用管線或導向檔案）就關掉顏色，避免跑出一堆亂碼
[ -t 1 ] || USE_COLOR=0

# ---------- 畫面輔助 ----------
if [ "$USE_COLOR" = 1 ]; then
  c_g='\e[1;32m'; c_b='\e[1;34m'; c_y='\e[1;33m'; c_r='\e[1;31m'; c_c='\e[1;36m'; c_0='\e[0m'
else c_g=''; c_b=''; c_y=''; c_r=''; c_c=''; c_0=''; fi
info() { echo -e "${c_b}[資訊]${c_0} $*"; }
ok()   { echo -e "${c_g}[完成]${c_0} $*"; }
warn() { echo -e "${c_y}[注意]${c_0} $*"; }
die()  { echo -e "${c_r}[錯誤]${c_0} $*" >&2; exit 1; }
step() { echo; echo -e "${c_g}========== $* ==========${c_0}"; echo; }
banner() {
  echo -e "${c_c}"
  echo "   AI Agent 治理藍隊環境  ·  Wazuh 版  ·  一鍵安裝"
  echo "   governed blue-team lab — one-command installer"
  echo -e "${c_0}"
}
# 是/否；$2 預設 Y 或 N；--yes 直接取預設
ask_yn() {
  local prompt="$1" def="${2:-Y}" ans
  if [ "$ASSUME_YES" = 1 ]; then [ "$def" = Y ]; return; fi
  local hint="[Y/n]"; [ "$def" = N ] && hint="[y/N]"
  read -r -p "$(echo -e "${c_y}$prompt $hint ${c_0}")" ans || true
  ans="${ans:-$def}"; [[ "$ans" =~ ^[Yy]$ ]]
}
# 文字輸入；$2 預設值；--yes 直接取預設
ask_val() {
  local prompt="$1" def="$2" ans
  if [ "$ASSUME_YES" = 1 ]; then echo "$def"; return; fi
  read -r -p "$(echo -e "${c_y}$prompt ${c_0}[預設 $def]：")" ans || true
  echo "${ans:-$def}"
}
# 二選一選單；回傳 1 或 2。$1 題目 $2 選項1 $3 選項2 $4 預設(1/2)
ask_choice2() {
  local title="$1" o1="$2" o2="$3" def="${4:-1}" ans
  if [ "$ASSUME_YES" = 1 ]; then echo "$def"; return; fi
  echo -e "${c_y}$title${c_0}" >&2
  echo -e "  ${c_c}1)${c_0} $o1" >&2
  echo -e "  ${c_c}2)${c_0} $o2" >&2
  read -r -p "$(echo -e "${c_y}請選 1 或 2 ${c_0}[預設 $def]：")" ans || true
  ans="${ans:-$def}"; case "$ans" in 1|2) echo "$ans" ;; *) echo "$def" ;; esac
}
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 16
  else head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

banner

# =============================================================================
step "第 0 步：檢查主機環境"
# =============================================================================
[ -f lab.sh ] || die "找不到 lab.sh；請在解壓後的專案資料夾內執行這支安裝器。"
[ -f docker-compose.wazuh.yml ] || die "找不到 docker-compose.wazuh.yml。"
[ -f .env.example ] || die "找不到 .env.example。"

OS_ID="unknown"; OS_PRETTY="unknown"
if [ -f /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-unknown}"; OS_PRETTY="${PRETTY_NAME:-$OS_ID}"; fi
ARCH="$(uname -m)"
info "作業系統：$OS_PRETTY"
info "CPU 架構：$ARCH（amd64/x86_64 與 arm64/aarch64 皆支援，含 DGX Spark）"
case "$ARCH" in x86_64|amd64|aarch64|arm64) : ;; *) warn "未驗證的架構 $ARCH，Wazuh 映像可能沒有對應版本。" ;; esac
MEM_GB=$(awk '/MemTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "?")
info "記憶體：${MEM_GB} GiB（建議 ≥ 8 GiB；本環境閒置約 2.8 GiB，另加模型需求）"
awk "BEGIN{exit !(${MEM_GB:-0} < 7.5)}" 2>/dev/null && warn "記憶體偏低，indexer 可能吃緊。"
DISK_AVAIL=$(df -BG --output=avail "$ROOT_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
[ -n "${DISK_AVAIL:-}" ] && { info "可用磁碟：${DISK_AVAIL} GiB（映像約 8 GiB，建議 ≥ 20 GiB）"; [ "${DISK_AVAIL:-0}" -lt 15 ] && warn "磁碟空間偏低。"; }

# =============================================================================
step "第 1 步：Docker"
# =============================================================================
# 決定要「只檢查」還是「自動安裝」
DOCKER_MODE="$OPT_DOCKER"
if [ -z "$DOCKER_MODE" ]; then
  if command -v docker >/dev/null 2>&1; then
    # 已偵測到 Docker，預設只檢查
    sel=$(ask_choice2 "這台機器的 Docker 狀態？（已偵測到 Docker）" \
      "我已經裝好 Docker（只檢查，不安裝）【建議】" \
      "重新／補裝 Docker（Debian/Ubuntu 自動安裝）" 1)
  else
    # 沒偵測到 Docker，預設自動安裝
    sel=$(ask_choice2 "這台機器的 Docker 狀態？（尚未偵測到 Docker）" \
      "我已經裝好 Docker，只是這裡沒偵測到（只檢查）" \
      "尚未安裝，請自動幫我裝（Debian/Ubuntu）【建議】" 2)
  fi
  [ "$sel" = 1 ] && DOCKER_MODE="have" || DOCKER_MODE="install"
fi

if [ "$DOCKER_MODE" = "have" ]; then
  command -v docker >/dev/null 2>&1 || die "選了「已安裝」但找不到 docker 指令。請確認 Docker 已安裝、或改用自動安裝（--docker install）。"
  ok "使用既有 Docker（$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)）。"
else
  if command -v docker >/dev/null 2>&1; then
    ok "已有 Docker（$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)），略過安裝。"
  else
    case "$OS_ID" in
      ubuntu|debian|raspbian|linuxmint|pop)
        info "安裝相依套件與 Docker（官方 get.docker.com，需要 sudo）…"
        $SUDO apt-get update -y
        $SUDO apt-get install -y curl ca-certificates git unzip
        curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
        $SUDO sh /tmp/get-docker.sh
        $SUDO systemctl enable --now docker 2>/dev/null || true
        [ "$(id -u)" -ne 0 ] && $SUDO usermod -aG docker "$USER" 2>/dev/null || true
        ok "Docker 安裝完成。"
        warn "若等一下出現權限錯誤，請登出再登入（讓 docker 群組生效），或改用 sudo 重跑。"
        ;;
      *) die "自動安裝僅支援 Debian/Ubuntu 類系統；你的系統是 $OS_ID。請手動安裝 Docker 後，用 ./install.sh --docker have 重跑。" ;;
    esac
  fi
fi
# 驗證 Compose v2 與 daemon
docker compose version >/dev/null 2>&1 || die "偵測不到 Docker Compose v2（指令 'docker compose'）。請安裝後重跑。"
ok "Docker Compose v2 可用。"
if ! docker info >/dev/null 2>&1; then
  warn "目前無法連到 Docker daemon（服務未啟動，或帳號不在 docker 群組）。"
  ask_yn "改用 sudo 繼續？" Y || die "請處理 Docker 權限後重跑。"
  warn "注意：本安裝器後續的 docker 指令不會自動加 sudo；建議把帳號加入 docker 群組並重新登入後再跑。"
fi
# vm.max_map_count
CUR_MMC=$(sysctl -n vm.max_map_count 2>/dev/null || echo 0)
if [ "${CUR_MMC:-0}" -ge 262144 ]; then
  ok "vm.max_map_count 已是 ${CUR_MMC}。"
else
  info "設定 vm.max_map_count=262144（Wazuh indexer 需要；目前 ${CUR_MMC}）…"
  $SUDO sysctl -w vm.max_map_count=262144 >/dev/null 2>&1 && ok "已設定（本次開機生效）。" || warn "設定失敗，indexer 可能起不來。"
  ask_yn "要寫入設定讓重開機後仍生效嗎？" Y && {
    echo "vm.max_map_count=262144" | $SUDO tee /etc/sysctl.d/99-wazuh-max-map-count.conf >/dev/null 2>&1 \
      && ok "已寫入 /etc/sysctl.d/99-wazuh-max-map-count.conf。" || warn "寫入失敗，可稍後手動處理。"; }
fi

# =============================================================================
step "第 2 步：模型服務（Ollama／vLLM）"
# =============================================================================
# 決定要「指向現有」還是「本機安裝 Ollama」
OLLAMA_MODE="$OPT_OLLAMA"
if [ -z "$OLLAMA_MODE" ]; then
  sel=$(ask_choice2 "模型服務要怎麼準備？（本環境不含模型，Agent 需要一個支援 tool calling 的模型）" \
    "我已經有 Ollama／vLLM，指過去就好【建議，例如你的 DGX】" \
    "在這台機器安裝 Ollama 並下載一個模型" 1)
  [ "$sel" = 1 ] && OLLAMA_MODE="point" || OLLAMA_MODE="install"
fi

# 預設模型：指向 DGX 等 GPU 主機時用大模型；在沒有 NVIDIA GPU 的機器本機安裝時改用 8B 小模型
HAS_GPU=0
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 && HAS_GPU=1
if [ -n "$OPT_MODEL" ]; then
  DEF_MODEL="$OPT_MODEL"
elif [ "$OLLAMA_MODE" = "install" ] && [ "$HAS_GPU" = 0 ]; then
  DEF_MODEL="qwen3:8b"
else
  DEF_MODEL="gemma4:31b"
fi
if [ "$OLLAMA_MODE" = "point" ]; then
  DEF_URL="${OPT_MODEL_URL:-http://host.docker.internal:11434}"
  echo
  info "指向現有模型服務："
  info "  · 模型在「這台主機」→ 用預設 http://host.docker.internal:11434"
  info "  · 模型在「另一台」（例如 DGX）→ 填 http://<該台IP>:11434（結尾不要加斜線或 /v1）"
  LLM_UPSTREAM=$(ask_val "模型服務位址 LLM_UPSTREAM" "$DEF_URL")
  MODEL=$(ask_val "模型名稱 MODEL（需支援 tool calling）" "$DEF_MODEL")
else
  # 本機安裝 Ollama
  warn "將在這台機器安裝 Ollama 並下載模型；模型可能數 GB 到數十 GB，請確認磁碟與網路。"
  if [ "$HAS_GPU" = 0 ]; then
    warn "這台機器偵測不到 NVIDIA GPU，模型只能用 CPU 跑：預設改用 qwen3:8b，每題回答可能要數十秒到數分鐘。"
    warn "要在媒體或會議展示，建議改用「指向現有模型服務」，讓模型跑在 DGX 上。"
  fi
  MODEL=$(ask_val "要下載哪個模型？（需支援 tool calling；大模型如 gemma4:31b 需要較好的 GPU）" "$DEF_MODEL")
  if command -v ollama >/dev/null 2>&1; then
    ok "已偵測到 Ollama，略過安裝。"
  else
    info "安裝 Ollama（官方 install.sh）…"
    curl -fsSL https://ollama.com/install.sh | sh || die "Ollama 安裝失敗，請見 https://ollama.com/download 手動安裝後，用 --ollama point 重跑。"
  fi
  # 讓 Ollama 綁 0.0.0.0，容器才連得到（經 host.docker.internal）
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service'; then
    info "設定 Ollama 對外監聽（OLLAMA_HOST=0.0.0.0）…"
    $SUDO mkdir -p /etc/systemd/system/ollama.service.d
    printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' | $SUDO tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null
    $SUDO systemctl daemon-reload && $SUDO systemctl restart ollama && ok "Ollama 已設定對外監聽。" || warn "重啟 Ollama 失敗，稍後請手動確認。"
  else
    warn "偵測不到 systemd 管理的 ollama 服務；請自行確認 Ollama 以 OLLAMA_HOST=0.0.0.0 啟動，容器才連得到。"
    $SUDO pkill -x ollama 2>/dev/null || true
    OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >/tmp/ollama.log 2>&1 &
    sleep 3
  fi
  info "下載模型 $MODEL（可能要一段時間）…"
  ollama pull "$MODEL" || warn "模型下載失敗，稍後可手動：ollama pull $MODEL"
  # 容器經由 host.docker.internal 連到本機 Ollama（compose 已設 extra_hosts）
  LLM_UPSTREAM="http://host.docker.internal:11434"
  # 快速確認可連
  curl -s "http://localhost:11434/api/tags" >/dev/null 2>&1 && ok "本機 Ollama 可連（:11434）。" || warn "本機 Ollama 尚未回應，稍後請確認 ollama serve 是否在跑。"
fi

# =============================================================================
step "第 3 步：產生設定檔 .env"
# =============================================================================
SKIP_ENV=0
if [ -f .env ]; then
  if ask_yn ".env 已存在，要沿用它（不覆蓋設定）嗎？" N; then
    ok "沿用現有 .env。"; SKIP_ENV=1
  else
    cp -f .env ".env.bak.$(date +%Y%m%d-%H%M%S)"; info "已備份舊 .env。"
  fi
fi

DETECT_IP=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -z "$DETECT_IP" ] && DETECT_IP="127.0.0.1"
if [ "$SKIP_ENV" = 0 ]; then
  HOST_IP=$(ask_val "這台主機對外的 IP（給你用瀏覽器連戰情室）" "$DETECT_IP")
  AGENT_TOKEN=$(rand_hex); DB_RO=$(rand_hex); SOAR_TOKEN=$(rand_hex)
  PORTAL_PIN=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 )))
  ok "已自動產生受治理 Agent 憑證、資料庫唯讀密碼、SOAR admin token、入口網站操作 PIN（亂數）。"
  cp .env.example .env
  sed -i \
    -e "s#^LLM_UPSTREAM=.*#LLM_UPSTREAM=${LLM_UPSTREAM}#" \
    -e "s#^MODEL=.*#MODEL=${MODEL}#" \
    -e "s#^AGENT_TOKEN_SOC01=.*#AGENT_TOKEN_SOC01=${AGENT_TOKEN}#" \
    -e "s#^DB_RO_PASSWORD=.*#DB_RO_PASSWORD=${DB_RO}#" \
    -e "s#^SOAR_ADMIN_TOKEN=.*#SOAR_ADMIN_TOKEN=${SOAR_TOKEN}#" \
    -e "s#^PORTAL_PIN=.*#PORTAL_PIN=${PORTAL_PIN}#" \
    -e "s@^# COMPOSE_FILE=docker-compose.wazuh.yml@COMPOSE_FILE=docker-compose.wazuh.yml@" \
    .env
  grep -q "^COMPOSE_FILE=docker-compose.wazuh.yml" .env || echo "COMPOSE_FILE=docker-compose.wazuh.yml" >> .env
  ok "已寫好 .env（Wazuh 版，模型＝${MODEL}）。"
  echo "$HOST_IP" > .host_ip
fi
HOST_IP=$(cat .host_ip 2>/dev/null || echo "$DETECT_IP")

# =============================================================================
step "第 4 步：佈署（起容器 → 匯入假資料）"
# =============================================================================
warn "第一次會下載多個映像（合計約 8 GB）與 Grafana 外掛，依網速可能要數分鐘，請耐心等。"
chmod +x lab.sh
info "執行 ./lab.sh up …"
./lab.sh up || die "佈署失敗。可用 ./lab.sh logs 看錯誤，或見 docs 內操作手冊 §9 疑難排解。"
info "等待 Wazuh indexer 就緒（最多約 3 分鐘）…"
READY=0
for i in $(seq 1 36); do
  if docker compose exec -T wazuh.indexer \
       curl -sk -u admin:SecretPassword https://localhost:9200/_cluster/health 2>/dev/null | grep -q '"status"'; then READY=1; break; fi
  sleep 5
done
[ "$READY" = 1 ] && ok "indexer 已就緒。" || warn "等不到 indexer 就緒；稍後可手動執行 ./lab.sh seed。"
[ "$READY" = 1 ] && { info "匯入假資料（./lab.sh seed）…"; ./lab.sh seed || warn "seed 失敗，稍後可重跑：./lab.sh seed"; }

# =============================================================================
step "安裝完成"
# =============================================================================
echo -e "${c_g}環境已佈署。用瀏覽器打開：${c_0}"
echo
PORTAL_PORT_SHOW="$(grep -E '^PORTAL_PORT=' .env 2>/dev/null | cut -d= -f2-)"
PIN_SHOW="$(grep -E '^PORTAL_PIN=' .env 2>/dev/null | cut -d= -f2-)"
echo -e "  ${c_c}入口網站（從這裡開始）${c_0}  http://${HOST_IP}:${PORTAL_PORT_SHOW:-8080}     操作 PIN：${PIN_SHOW:-（未設定）}"
echo -e "  ${c_c}戰情室（展示大螢幕）${c_0}  http://${HOST_IP}:3000     帳密 admin / agentlab"
echo -e "  ${c_c}Wazuh 技術細節${c_0}        https://${HOST_IP}:8443    帳密 admin / SecretPassword（自簽憑證，按「繼續」）"
echo
echo -e "${c_y}在入口網站按「同時問兩個 Agent」即可對照；也可以用指令列：${c_0}"
echo "  docker compose run --rm agent-baseline python agent.py \"公司目前共有幾位員工？\"   # 未治理"
echo "  docker compose run --rm agent-governed python agent.py \"公司目前共有幾位員工？\"   # 受治理"
echo "  docker compose run --rm agent-governed python run_tests.py --repeat 5              # 整份考卷"
echo
echo -e "${c_y}日常操作：${c_0}"
echo "  ./lab.sh status     看容器狀態"
echo "  ./lab.sh down       收起（留資料）      ./lab.sh up  恢復"
echo "  ./uninstall.sh      解除安裝（soft／full 清除選單）"
echo
LLM_SHOW="$(grep -E '^LLM_UPSTREAM=' .env 2>/dev/null | cut -d= -f2-)"
warn "模型：Agent 需連到 ${LLM_SHOW:-見 .env}；若剛在本機裝 Ollama，請確認該模型已 pull 完成。"
warn "本包帶的是 demo 帳密，只能用在隔離的實驗網路；對外展示或接真實資料前請改密碼（見 docs 操作手冊 §11）。"
echo
ok "詳細步驟與判讀請見 docs/ 內《操作手冊》。"
