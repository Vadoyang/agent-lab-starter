# AGENTS.md — 給自動化佈署代理（ChatGPT／Codex 等）的工作規則

本檔給在這個資料夾裡工作的 AI 代理讀。人類使用者請看 README.md。

## 你的任務

在這台 Windows 11 Pro 主機上**佈署並自行排除問題**，直到驗收通過：

> `verify-windows.ps1 -Stage Post -WithModel` 的整體結果是 `PASS`。

步驟在 `deploy/codex/RUNBOOK.md`；遇到問題時的判讀與修法在 `deploy/codex/TROUBLESHOOTING.md`。
遇到錯誤**不要先停下來問**：先診斷、查知識庫、套用允許的修法、再驗收。只有本檔列出的「要先問」與「需要人」的情況才停。

這套環境本身就是「把 AI Agent 管住」的實驗平台。你也是一個被授權在這台主機上做事的 AI Agent，
行為要符合同樣的原則：**權限最小、每一步可稽核、不為了通過檢查而降低防護。**

---

## 自癒迴圈（遇到任何失敗都照這個順序）

1. **看問題**：執行 `.\repair-windows.ps1 -Diagnose`，讀這三份報告：
   - `deploy-logs\repair-windows-latest.json`（Windows 端未通過項目與修法代碼）
   - `deploy-logs\wsl-diagnose-latest.json`（WSL 端已知問題比對、證據、可自動修的代碼）
   - `deploy-logs\install-windows-*.log`、WSL 內 `results/install-latest.log`（安裝過程完整紀錄）
2. **自動修**：執行 `.\repair-windows.ps1 -Auto`。它會套用所有可自動修的修法（`WF*`、WSL 端 `F*`），修完重新驗收，最多 3 輪；
   套用後無效的修法會被標記、不再重試。
3. **查知識庫**：仍有未通過項目時，用報告裡的代碼到 `TROUBLESHOOTING.md` 查原因與手動步驟，在「允許的動作」範圍內處理。
4. **再驗收**：每次修改後都重新執行 `.\verify-windows.ps1 -Stage Post`（模型就緒時加 `-WithModel`）。
5. **上限與升級**：同一個問題最多處理 3 次。仍未解決、需要「要先問」的動作、或代碼是 `M*`（需要人），就停下來回報，附上證據。

每一個會改變系統狀態的動作，都要寫進 `deploy-logs\deploy-log.md`（見文末格式）。

---

## 允許你自行執行的動作（不用先問，但要記錄）

- `deploy/codex/RUNBOOK.md` 與 `TROUBLESHOOTING.md` 裡標為「自動」的所有步驟。
- `install-windows.ps1`（一般安裝與 `-Update`）、`verify-windows.ps1`、`repair-windows.ps1`。
- WSL 內：`./lab.sh up | ensure | update | seed | status | logs | verify | diagnose | repair`，
  以及本專案的 `docker compose ps | logs | restart | up -d | build`。
- `wsl --shutdown` 後重新啟動、在 WSL 內 `systemctl start docker`。
- 修改 `.env` 中**非秘密**的設定：`LLM_UPSTREAM`、`MODEL`、`GUARD_MODEL`、`LLM_ALLOWED_MODELS`、`PORTAL_PORT`、`GRAFANA_PORT`、
  `WAZUH_DASHBOARD_PORT`（埠號被占用時）。注意：改埠號後 Windows 防火牆規則與網址也要跟著改，優先改用 TROUBLESHOOTING 的 M20 處理。改完執行 `./lab.sh up`。不可修改 token、密碼、PIN，也不可把 `GUARDRAILS_DEFAULT` 改成 `0`。
- **修正佈署腳本的錯誤**：`install-windows.ps1`、`install.sh`、`lab.sh`、`verify-windows.ps1`、`repair-windows.ps1`、
  `tools/agentlab_doctor.py`、`deploy/codex/*.md`。條件：
  1. 修改是為了讓佈署能繼續（不是為了讓某個檢查「看起來」通過）；
  2. 改動最小，並把**改了哪個檔、哪幾行、為什麼、改前改後**寫進 `deploy-log.md`；
  3. 改完先執行 `.\install-windows.ps1 -Update` 把程式碼同步進 WSL，再重新驗收；
  4. 不得放寬任何驗收條件（例如改門檻、刪檢查項、把 fail 改成 warn）。

## 絕對禁止（即使能讓檢查通過也不行）

1. **不放寬安全控制**：不改 `app/`（Agent、閘道、護欄、SOAR、模型代理的程式）、`app/policy.yaml`、
   `config/wazuh_cluster/local_rules.xml`、`docker-compose*.yml` 的網路設定與服務定義、驗收檢查的通過條件。
   網路隔離（C05）、護欄（C07–C09、C14、C15、B10）、政策（B11）、模型代理（C10）未通過一律是 `M21`：停下來回報。
2. **不碰實驗考卷**：不開啟、不輸出、不轉述 `app/tests.yaml`；不執行 `run_tests.py`。
3. **不洩漏秘密**：不顯示 `.env` 的 token 與密碼，不把它們寫進 `deploy-log.md` 或回報。唯一可告訴使用者的是 `PORTAL_PIN`，只放在最後的回報。
4. **不降低主機防護**：不關 Windows Defender、不關 Windows 防火牆、不關 TLS 憑證檢查、不對網際網路開放服務、不建立對外通道（tunnel）。
   防火牆只可建立本套件定義的規則：Hyper-V 規則 `AgentLab-8080／3000／8443`，以及 portproxy 備援的 `AgentLab-PP-*`（僅私人／網域網路）。
5. **不安裝 Docker Desktop**，也不改用它。
6. **不動模型主機**：DGX／Ollama 只測連線，不登入、不改設定。

## 要先問使用者的動作

- 重新開機（腳本回傳 `3010`）、或需要人手動操作（腳本回傳 `2`，例如第一次開啟 Ubuntu）。
- 任何會刪除資料或環境的動作：`wsl --unregister`、`install-windows.ps1 -Reinstall`、`./uninstall.sh`、`./lab.sh destroy`、
  `docker compose down -v`、`docker volume rm`、`docker system prune`（含 volume）、刪除資料夾、重建資料庫、重新產生 `.env`（`--fresh-env`）。
- 安裝本套件以外的軟體、修改 BIOS、修改 `.wslconfig` 的記憶體上限（`WF4` 會保留原值，不算）。

---

## 卡住時可以直接執行的唯讀指令

```powershell
.\repair-windows.ps1 -Diagnose
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && ./lab.sh diagnose"
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && docker compose logs --tail=120 <服務名稱>"
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && tail -n 80 results/install-latest.log"
wsl -d Ubuntu-24.04 -u root -- bash -lc "df -h / && free -m && docker system df"
Get-Content $env:USERPROFILE\.wslconfig
```

`lab.sh` 本身壞掉（例如換行格式錯誤）時，直接執行診斷工具：
`wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && python3 tools/agentlab_doctor.py diagnose"`

服務名稱：`wazuh.indexer`、`wazuh.manager`、`wazuh.dashboard`、`grafana`、`postgres`、`toolproxy`、`guard`、`llm-proxy`、
`soar`、`portal`、`runner-governed`、`runner-baseline`、`victim`、`attacker-site`、`threatintel`、`websim`。

---

## `deploy-logs\deploy-log.md` 格式

每個階段或每次修復附加一段：

```
## <時間> 第 N 階段／修復：<簡述>
- 指令：<完整指令>（結束代碼 <n>）
- 依據：<報告檔與代碼，例如 wsl-diagnose-latest.json D17 → F17>
- 結果：<重新驗收的整體結果與仍未通過的代碼>
- 修改的檔案（若有）：<檔名、行號、改前→改後、理由>
```

## 完成的定義

`verify-windows.ps1 -Stage Post -WithModel` 的整體結果為 `PASS`，並依 RUNBOOK 第 4 階段格式回報。
模型主機尚未就緒時：不加 `-WithModel` 的整體 `PASS`，並明講 C11、C13 待模型就緒後補跑。
