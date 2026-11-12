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
  `get.ps1`（必須維持純 ASCII、不含 BOM）、`get.sh`、`tools/agentlab_doctor.py`、`deploy/codex/*.md`，
  以及 `README.md` 與 `docs/` 下說明安裝步驟的文件。條件：
  1. 修改是為了讓佈署能繼續（不是為了讓某個檢查「看起來」通過）；
  2. 改動最小，並把**改了哪個檔、哪幾行、為什麼、改前改後**寫進 `deploy-log.md`；
  3. 改完先執行 `.\install-windows.ps1 -Update` 把程式碼同步進 WSL，再重新驗收；
  4. 不得放寬任何驗收條件（例如改門檻、刪檢查項、把 fail 改成 warn）；
  5. 驗收通過後，依下方「把修正送回 GitHub」開分支與 PR，讓修正進到安裝包，之後所有人安裝都會拿到。
- 本資料夾是 git clone 時：`git status`、`git diff`、`git switch -c codex/...`、`git add <佈署檔>`、`git commit`、
  `git push -u origin codex/...`、`gh pr create`（細節見下方）。

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
7. **不直接改正式版**：不 push 到 `main`、不 `git push --force`、不自己合併 PR、不改 GitHub repo 設定、不刪分支或 tag。
   正式版只能由使用者在 GitHub 上按「Merge」更新。不改 `.github/`（PR 自動檢查的規則）。

## 要先問使用者的動作

- 重新開機（腳本回傳 `3010`）、或需要人手動操作（腳本回傳 `2`，例如第一次開啟 Ubuntu）。
- 任何會刪除資料或環境的動作：`wsl --unregister`、`install-windows.ps1 -Reinstall`、`./uninstall.sh`、`./lab.sh destroy`、
  `docker compose down -v`、`docker volume rm`、`docker system prune`（含 volume）、刪除資料夾、重建資料庫、重新產生 `.env`（`--fresh-env`）。
- 安裝本套件以外的軟體、修改 BIOS、修改 `.wslconfig` 的記憶體上限（`WF4` 會保留原值，不算）。

---

## 把修正送回 GitHub（讓安裝包本身變好）

這個資料夾是使用者從 GitHub `git clone` 下來的維護用副本。其他人用一行指令（`get.ps1`／`get.sh`）安裝時，
下載的是 GitHub 上 `main` 的版本。所以你修好的佈署腳本，要送回 GitHub、經使用者核准合併，安裝包才算真的修好。

**時機**：你修改過佈署檔，而且修改後 `verify-windows.ps1 -Stage Post`（模型就緒時加 `-WithModel`）整體 `PASS`。
沒修改任何檔案就不用做。

**步驟**（每一步照常寫進 `deploy-log.md`）：

1. 確認是 git clone：`git rev-parse --is-inside-work-tree` 回 `true`，且 `git remote get-url origin` 是 GitHub 網址。
   不是的話（例如用一行指令或 zip 安裝的資料夾），跳過本節，在回報裡附上 `git diff` 等效的改前改後內容，請使用者轉給維護者。
2. 第一次 commit 前設定這個資料夾的作者名（不要用使用者的個人 email）：
   `git config user.name "AgentLab Codex ($env:COMPUTERNAME)"`、`git config user.email "codex@agentlab.invalid"`
3. `git status --porcelain` 與 `git diff --stat`：**只能**出現「允許修改」清單裡的檔案
   （`install-windows.ps1`、`install.sh`、`lab.sh`、`verify-windows.ps1`、`repair-windows.ps1`、`get.ps1`、`get.sh`、
   `tools/agentlab_doctor.py`、`deploy/codex/*.md`、`README.md`、`docs/` 下的說明文件）。
   出現 `app/`、`config/`、`docker-compose*.yml`、`.env`、`deploy-logs/`、`deploy-report-*.json` 或任何清單外的檔案 → 不要 commit，
   把那些改動還原（`git restore <檔案>`），在回報裡說明。
4. 開分支並 commit：
   ```powershell
   git switch -c codex/fix-<yyyyMMdd>-<簡短英文描述>
   git add <逐一列出要送的檔案>        # 不要用 git add . 或 git add -A
   git commit -m "fix(deploy): <一句話>" -m "問題代碼：<例如 P05、D17>`n原因：<…>`n驗收：verify-windows -Stage Post <PASS 與否>`n主機：<Windows 版本、WSL 版本>"
   ```
5. 推上 GitHub：`git push -u origin <分支名>`。第一次推送會跳出瀏覽器要使用者登入 GitHub——這是「需要人」的步驟，告訴使用者按什麼後等待。
6. 開 PR：
   - 有 `gh` 且 `gh auth status` 正常：`gh pr create --base main --head <分支名> --title "<同 commit 標題>" --body-file deploy-logs\pr-body.md`
     （`pr-body.md` 你先寫好：問題、證據代碼、改了什麼、驗收結果；不含任何 token、密碼、PIN）。
   - 沒有 `gh`：給使用者這個網址，請他按「Create pull request」：`https://github.com/<owner>/<repo>/compare/main...<分支名>?expand=1`
7. 回報裡寫 PR 網址，並提醒使用者：看過「Files changed」沒問題再按「Merge pull request」。合併前不要再在同一分支以外的地方改同一個檔。
8. 使用者合併後，`git switch main`、`git pull --ff-only` 回到最新正式版。

同一次佈署修了好幾個問題，可以放在同一個分支、分成幾個 commit。下一次佈署開始前先 `git switch main` 與 `git pull --ff-only`。

## 沒辦法以系統管理員身分執行時

部分版本的 Codex 桌面程式即使以系統管理員身分開啟，PowerShell 仍會回 740「需要提升權限」。遇到時：
用 `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<完整路徑>\install-windows.ps1', ...`
執行需要權限的腳本（使用者要在 Windows 跳出的視窗按「是」），結束後從 `deploy-logs\` 的紀錄與報告檔讀結果，不要猜。

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
若你修改過佈署檔：分支已推上 GitHub，並已開好 PR（或已給使用者建立 PR 的網址）。
