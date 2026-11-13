# 佈署步驟（給 Codex 執行）

適用：Windows 11 Pro 主機（例如 HPE ML30 Gen11，64 GB 記憶體、無 GPU），模型放在另一台主機（DGX）上的 Ollama。
工作規則見根目錄 `AGENTS.md`；代碼與修法見 `TROUBLESHOOTING.md`。

**原則：遇到失敗不要先停。** 每個階段失敗時先走「自癒迴圈」（第 3 階段的 3B），只有 `AGENTS.md` 列為「要先問」或代碼為 `M*` 的情況才停下來問。

> 本檔與 `install-windows.ps1`、`verify-windows.ps1`、`repair-windows.ps1` 尚未在實體 Windows 主機上跑過。第一次執行時請人在旁核准。

---

## 第 0 階段：確認參數

| 參數 | 必填 | 說明 | 例子 |
|---|---|---|---|
| `REPO_DIR` | 是 | 套件在 Windows 上的資料夾（含 `install-windows.ps1`） | `D:\agentlab\agent-lab-starter`（放 C 槽也可以） |
| `WSL_DIR` | 否 | WSL 虛擬磁碟（Docker 映像、Wazuh 與資料庫的資料）要放的資料夾；不給就放系統碟。必須是本機 NTFS 磁碟、不能在 `REPO_DIR` 裡面；只對新安裝的發行版有效 | `D:\agentlab\wsl` |
| `LLM_URL` | 是 | 模型服務位址，結尾不要加斜線或 `/v1` | `http://192.168.1.50:11434` |
| `MODEL` | 是 | 模型名稱，必須和模型主機上 `ollama list` 顯示的名稱完全一樣（需支援 tool calling） | `gemma4:31b` |
| `HOST_IP` | 否 | 區網其他電腦連入口網站用的 IP；不給就自動偵測 | `192.168.1.20` |
| `GUARD_MODEL` | 否 | 護欄另用的本地防護模型；不給就只用規則 | （留空） |

缺必填參數就先問。`HOST_IP` 沒給時，列出候選讓使用者選：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object IPAddress, InterfaceAlias
```

確認版本來源：

```powershell
git rev-parse --is-inside-work-tree; git remote get-url origin; git status --short; git log -1 --oneline
```

- 是 git clone、在 `main`、沒有未提交的改動 → 先 `git pull --ff-only` 取得最新正式版。
- 有未提交的改動或不在 `main` → 讀 `deploy-logs\deploy-log.md` 了解上次做到哪，不要丟棄改動；不確定就問。
- 不是 git clone → 照常佈署，但第 5 階段無法開 PR（改用回報附改前改後）。

建立紀錄檔 `deploy-logs\deploy-log.md`，寫下參數（不含任何密碼）、版本（`git log -1 --oneline`）與開始時間。

**前置條件（使用者負責，你不可登入模型主機）**：模型主機（GB10／DGX）已依 `docs/新手操作手冊_GitHub與ChatGPT佈署_v3.md` 的 B 部分準備好——
Ollama 設 `OLLAMA_HOST=0.0.0.0:11434` 與 `OLLAMA_NO_CLOUD=1`、已 `ollama pull <MODEL>`、防火牆只放行這台主機連 11434。
Ollama 的 API 沒有帳號密碼；`.env` 的 `LLM_API_KEY=ollama` 是佔位字，不要向使用者索取 Ollama 帳密，也不要修改它。

**關卡 0**：必填參數齊全。

---

## 第 1 階段：佈署前檢查（只讀不改）

```powershell
cd <REPO_DIR>
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows.ps1 -Stage Pre -LlmUrl <LLM_URL> -Model <MODEL> -WslDir <WSL_DIR>
```

沒有 `WSL_DIR` 時拿掉 `-WslDir <WSL_DIR>`（W04 改看系統碟的空間）。

讀 `deploy-report-pre.json`。每個未通過項目都有 `fix` 代碼，到 `TROUBLESHOOTING.md` §1 查。
`W*` 大多是硬體、BIOS 或使用者決定的事：`M-BIOS`、`M-WINVER`、`M-DOCKERDESKTOP`、`M-HW`、`M-DISK`、`M-WSLDIR` 停下來問；
`W10`（模型連不到）可在使用者同意下繼續，模型就緒後補驗收；`W13`（模型主機還沒有 `MODEL`）請使用者在模型主機執行
`ollama pull <MODEL>`，或確認 `MODEL` 拼字與 `ollama list` 一致，同樣可在使用者同意下先繼續；`W06`（WSL 未安裝）是正常的。

**關卡 1**：整體 `PASS`，或剩下的項目已經使用者同意略過。

---

## 第 2 階段：安裝

需要系統管理員權限（以系統管理員身分啟動 Codex）。

```powershell
cd <REPO_DIR>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -WslDir <WSL_DIR> `
  -InstallArgs "--yes --docker install --ollama point --model-url <LLM_URL> --model <MODEL> --host-ip <HOST_IP>"
```

- 有 `GUARD_MODEL` 時在 `-InstallArgs` 最後加 `--guard-model <GUARD_MODEL>`；沒有 `HOST_IP` 時拿掉 `--host-ip <HOST_IP>`；沒有 `WSL_DIR` 時拿掉 `-WslDir <WSL_DIR>`。
- `-WslDir` 會記在 `deploy-logs\wsl-dir.txt`，之後重跑、`-Update`、驗收、修復都自動沿用，不必每次帶。
- 第一次會下載約 8 GB 映像，可能 20 分鐘以上。不要中斷；要看進度就讀 `deploy-logs\install-windows-*.log` 的最後幾行。

| 結束代碼 | 意思 | 你要做的事 |
|---|---|---|
| `0` | 完成 | 進第 3 階段 |
| `3010` | 剛裝好 WSL，需要重新開機 | **停**：請使用者重新開機，開機登入後以系統管理員身分重開 Codex，貼 PROMPT.md 的「重新開機之後」 |
| `2` | 需要人手動完成一步或做決定 | **停**：照輸出最後幾行 `[!]` 的說明請使用者處理——第一次啟動 Ubuntu（有 `WSL_DIR` 時會給一行要在終端機執行的指令，不要從開始功能表開）、`WSL_DIR` 不能用、或 Ubuntu 已經裝在別處（見 `TROUBLESHOOTING.md` M-WSLDIR）；處理完重跑第 2 階段 |
| `1` | 失敗 | **不要停**：進第 3 階段的 3B 自癒迴圈；修完後重跑同一個安裝指令 |

重跑安裝是安全的：沿用已安裝的 WSL 與發行版；WSL 內已有環境時只同步程式碼（保留 `.env`、紀錄、憑證、結果），
`install.sh` 沿用既有 `.env`（token 與 PIN 不變），只套用這次明確給的參數，並補上新版才有的設定鍵。

**關卡 2**：`install-windows.ps1` 結束代碼為 `0`。

---

## 第 3 階段：驗收與自癒

### 3A 驗收

```powershell
cd <REPO_DIR>
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows.ps1 -Stage Post -WithModel
```

剛裝完時 Wazuh indexer 可能還在啟動。第一次失敗且只有 C02／C12／B06 時，等 3 分鐘再跑一次。

驗收內容：Windows 端（`.wslconfig`、systemd、防火牆、排程、入口網站與 Grafana 可連、WSL 內程式碼是否同步、有 `WSL_DIR` 時虛擬磁碟是否真的在那裡（P12）），
加上 WSL 內 `./lab.sh verify --with-model`：容器（16 個）、Wazuh 規則、`.env`、網路隔離、四個檢查點的護欄自我測試、
模型代理白名單、模型連線、告警可查、良性冒煙測試，以及第三章 lab 的資料面（B09）、內容擷取（B10）、筆記授權（B11）、
護欄規避（C14）、外部網址遮蔽（C15）。

### 3B 自癒迴圈（3A 未通過時）

1. `.\repair-windows.ps1 -Auto`（模型就緒時加 `-WithModel`）。
   它會依每個未通過項目的 `fix` 代碼自動套用 `WF*` 與 WSL 端 `F*` 修法，修完重新驗收，最多 3 輪；無效的修法不再重試。
2. 讀 `deploy-logs\repair-windows-latest.json`：
   - `result: PASS` → 回到 3A 再跑一次完整驗收（含 `-WithModel`）確認。
   - `needs_human` 有項目 → 逐一到 `TROUBLESHOOTING.md` 查。是「自動」或允許的手動步驟就照做；是 `M*` 或要先問的就停。
   - `ineffective_fixes` 有項目 → 讀 `deploy-logs\wsl-diagnose-latest.json` 的 `evidence` 與 WSL 診斷包裡該服務的 log，找出真正原因；
     在允許範圍內處理（包含修正佈署腳本，見 `AGENTS.md`），處理後回到 1。
3. 同一個問題處理超過 3 次仍未解決 → 停，回報證據。
4. 安全控制項目（C05、C07–C10、C14、C15、B10、B11，代碼 `M21`）未通過 → **立即停**，不可為了通過而修改程式、政策、規則或驗收條件。

每一輪都寫進 `deploy-log.md`。

**關卡 3**：`-Stage Post -WithModel` 整體 `PASS`。模型尚未就緒時：不加 `-WithModel` 的整體 `PASS`，並註明 C11／C13 待補。

---

## 第 4 階段：回報

所有數字與結果都要來自報告檔，不要憑印象寫。

```
佈署結果：PASS／FAIL
報告檔：deploy-report-pre.json、deploy-report-post.json、deploy-logs\repair-windows-latest.json、deploy-logs\deploy-log.md

網址
  入口網站  http://<HOST_IP>:8080   操作 PIN：<PORTAL_PIN>
  Grafana   http://<HOST_IP>:3000
  Wazuh     https://<HOST_IP>:8443（自簽憑證）

驗收摘要（來自 deploy-report-post.json）
  必要項：通過 <n>／<總數>；未通過：<代碼或「無」>；警告：<代碼或「無」>
  冒煙測試：受治理 Agent 耗時 <latency_s> 秒，鐵律一 <守住/失守>，鐵律二 <守住/失守>

自動排除過的問題
  - <代碼>：<原因> → <修法>（<結果>）

我修改過的佈署腳本（若有）
  - <檔名>：<改了什麼、為什麼>（詳見 deploy-log.md）
  - PR：<網址，或「請到這個網址按 Create pull request」>；請看過 Files changed 再按 Merge

需要人接手的事
  - 從另一台電腦開啟入口網站，確認區網連得到
  - 在模型主機設定 OLLAMA_NO_CLOUD=1（若尚未設定）
  - 對外展示前更改 Grafana（admin／agentlab）與 Wazuh（admin／SecretPassword）的示範密碼
  - （其他 needs_human 項目）
```

`PORTAL_PIN` 用這個指令讀（只讀這一行）：

```powershell
wsl -d Ubuntu-24.04 -u root -- bash -lc "grep '^PORTAL_PIN=' /root/agent-lab-starter/.env | cut -d= -f2"
```

---

## 第 5 階段：把修正送回 GitHub（有修改佈署檔時）

照 `AGENTS.md` 的「把修正送回 GitHub」：檢查只改了允許的檔案 → 開 `codex/fix-…` 分支 → 逐一 `git add` → commit →
`git push -u origin <分支>` → `gh pr create`（沒有 `gh` 就給使用者 compare 網址）。不可 push 到 `main`、不可自己合併。

**關卡 5**：PR 已建立（或已給出建立網址），網址寫在第 4 階段回報與 `deploy-log.md`。

---

## 日常與後續情況

| 情況 | 做法 |
|---|---|
| 你修改了佈署腳本 | `.\install-windows.ps1 -Update` → 3A 驗收 → 第 5 階段 |
| 使用者在 GitHub 合併了新版 | `git switch main` → `git pull --ff-only` → `.\install-windows.ps1 -Update` → 3A 驗收 |
| 主機重新開機後 | 使用者登入後等 2 分鐘 → 3A；不過就 3B |
| 模型主機稍後才就緒 | 3A 加 `-WithModel`；不過就 3B |
| 只想看目前狀態 | `.\repair-windows.ps1 -Diagnose`（不修改任何東西） |

---

## 給使用者：Codex 的建議設定

| 設定 | 建議 | 原因 |
|---|---|---|
| 啟動方式 | 以系統管理員身分開 ChatGPT／Codex 桌面程式 | 安裝與防火牆修復需要系統管理員權限，Agent 繼承程式的權限；仍出現 740 錯誤時見 `AGENTS.md`「沒辦法以系統管理員身分執行時」 |
| Agent 執行環境 | PowerShell（不要切到 WSL 模式） | 腳本都是 PowerShell，會自己呼叫 `wsl.exe` |
| 核准模式 | 「Ask for approval」 | 每一個寫入、連網、提權的動作都經人核准；自癒迴圈仍會照常執行，只是每一步請你按核准 |
| 不要用 | Full access、核准政策設為 never | 會讓 Agent 不受專案資料夾與核准限制 |
| 工作資料夾 | 開在 `<REPO_DIR>`（用 `git clone` 下載的資料夾） | Codex 才會讀到根目錄的 `AGENTS.md`，修正也才能用 PR 送回 GitHub |
| Windows 帳號名稱 | 最好是英文 | Codex 社群回報：使用者資料夾路徑含非英文字元時可能啟動失敗，可設環境變數 `CODEX_HOME` 指到英文路徑 |
