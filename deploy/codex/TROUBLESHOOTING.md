# 疑難排解知識庫（給 Codex 與人使用）

用法：從報告裡拿到代碼，在本檔找到同一個代碼，照「自動」或「手動」欄處理，再用「確認」欄驗證。
所有修復都要記錄到 `deploy-logs\deploy-log.md`。工作規則（允許、禁止、要先問）見根目錄 `AGENTS.md`。

| 報告 | 位置 | 內容 |
|---|---|---|
| 佈署前檢查 | `deploy-report-pre.json` | `W*` 項目與修法代碼 |
| 佈署後驗收 | `deploy-report-post.json`、`deploy-logs\verify-post-*.json` | `P*`（Windows）＋`B*`／`C*`（WSL）項目，每項附 `fix` |
| Windows 修復 | `deploy-logs\repair-windows-latest.json` | 套用了哪些修法、無效的修法、仍需人處理的項目 |
| WSL 診斷 | `deploy-logs\wsl-diagnose-latest.json`（WSL 內 `results/diagnose-latest.json`） | `D*` 問題、證據、`F*`／`M*` 修法 |
| WSL 診斷包 | WSL 內 `results/diagnose-<時間>/` | 各服務最近 300 行 log、`docker compose ps`、磁碟、記憶體、監聽埠 |
| 安裝紀錄 | `deploy-logs\install-windows-*.log`、WSL 內 `results/install-latest.log` | 安裝過程完整輸出 |

代碼開頭的意思：`WF*`＝Windows 端可自動修；`F*`＝WSL 端可自動修；`WSL`＝交給 WSL 端 `./lab.sh repair auto`；`M*`、`INSTALL`＝需要人或需要重跑安裝。

---

## 1. Windows 端（`W*` 佈署前、`P*` 佈署後）

| 代碼 | 意思 | 修法 | 處理 | 確認 |
|---|---|---|---|---|
| W01 | Windows 組建 < 22621 | M-WINVER | 手動：請使用者跑 Windows Update 到 22H2 以上 | 重跑 `-Stage Pre` |
| W02 | BIOS 未開虛擬化 | M-BIOS | 手動：需要人進 BIOS 開 Intel VT-x／VT-d | 重跑 `-Stage Pre` |
| W03／W04 | 記憶體 < 48 GB／系統碟 < 80 GB | M-HW／M-DISK | 回報數字，由使用者決定 | — |
| W05 | 有待重新開機的更新（warn） | — | 建議使用者先重開機；不影響繼續 | — |
| W06 | WSL 未安裝（warn） | INSTALL | 正常，`install-windows.ps1` 會裝；第一次會要求重開機（3010） | — |
| W07 | 已安裝 Docker Desktop | M-DOCKERDESKTOP | **要先問**：請使用者解除安裝 Docker Desktop，或放棄。不可自行解除安裝 | 重跑 `-Stage Pre` |
| W09 | 下載來源連不到 | M19 | 見 §4 M19 | 重跑 `-Stage Pre` |
| W10 | 模型服務連不到 | M13 | 見 §4 M13；可在使用者同意下先佈署平台 | — |
| W11 | 非系統管理員（warn） | M-ADMIN | 請使用者以系統管理員身分重開 Codex | — |
| W12 | 8080／3000／8443 被占用 | M20 | 見 §4 M20 | 重跑 `-Stage Pre` |
| P01 | WSL 發行版沒裝好 | INSTALL | 自動：重跑 RUNBOOK 第 2 階段的安裝指令（同一組參數） | `-Stage Post` |
| P02 | `.wslconfig` 缺少必要設定 | WF4 | 自動：`.\repair-windows.ps1 -Fix WF4`（保留原記憶體值、備份原檔、重啟 WSL） | `-Stage Post` |
| P03 | WSL 內 systemd 沒開 | WF7 | 自動：`.\repair-windows.ps1 -Fix WF7` | `-Stage Post` |
| P04 | Hyper-V 防火牆規則缺 | WF2 | 自動（需系統管理員）：`.\repair-windows.ps1 -Fix WF2` | `-Stage Post` |
| P05 | 登入自動啟動排程缺（warn） | WF3 | 自動（需系統管理員）：`.\repair-windows.ps1 -Fix WF3` | `-Stage Post` |
| P06 | 入口網站在 WSL 內與 Windows 都連不到 | WF1 | 自動：`.\repair-windows.ps1 -Fix WF1`（啟動 Docker、起齊容器）；仍不行看 WSL 診斷 | `-Stage Post` |
| P11 | WSL 內正常、Windows 連不到 | WF5 | 自動（需系統管理員）：先確認 `.wslconfig` 有 `networkingMode=mirrored`（WF4），仍不行用 `-Fix WF5`（portproxy 備援） | `-Stage Post` |
| P07 | 用區網 IP 連不到 | WF2→WF5 | 自動：先 WF2；無效時 `-Auto` 會改試 WF5。最終仍需人從另一台電腦測 | 另一台電腦開 `http://<IP>:8080` |
| P08 | Grafana 連不到 | WF1 | 同 P06 | `-Stage Post` |
| P09 | WSL 內程式碼比本資料夾舊 | WF6 | 自動：`.\install-windows.ps1 -Update`（保留 .env、紀錄、憑證） | `-Stage Post` |
| P10 | WSL 內驗收報告讀不到 | WF1 | 自動：WF1 後重跑；仍不行直接在 WSL 執行 `./lab.sh verify` 看錯誤 | `-Stage Post` |

## 2. WSL 端診斷問題（`D*`，來自 `./lab.sh diagnose`）

| 代碼 | 意思 | 修法 | 自動做什麼 | 手動替代／注意 |
|---|---|---|---|---|
| D01 | Docker 服務沒在跑 | F01 | `systemctl start docker` | 若 systemd 沒開，先 Windows 端 WF7 |
| D02 | `vm.max_map_count` 不足或未永久保存 | F02 | `sysctl -w` ＋寫入 `/etc/sysctl.d/99-agentlab.conf` | 套用後仍在 → 回報（WSL 核心不允許時需人處理） |
| D03 | 有常駐服務沒在跑 | F03 | `./lab.sh up` | 起不來時看該服務 log（診斷包 `logs/<服務>.log`） |
| D04 | 服務反覆重啟 | F04 | 保存 log 後重啟該服務 | 若同時有 OOM → M04 |
| D04（OOM） | 容器記憶體不足被終止 | M04 | — | **要先問**：調高 `.wslconfig` 的 `memory` 後 `wsl --shutdown` |
| D05 | 磁碟剩餘 < 10 GB | F05 | 清 build cache 與無標籤映像（不刪 volume） | 仍不足 → 回報；Wazuh 弱點偵測必須保持關閉（B08） |
| D06 | Wazuh 規則或設定沒生效 | F06 | `docker compose up -d --force-recreate wazuh.manager` | `restart` 不會生效，一定要 force-recreate |
| D07 | Wazuh indexer 未就緒 | F07 | 等最多 5 分鐘，逾時重啟 indexer 一次 | 剛安裝完需要幾分鐘，先等再判斷 |
| D08 | 紀錄檔、工作佇列、筆記種子或憑證缺 | F08 | `./lab.sh ensure` | — |
| D09 | Wazuh 元件憑證錯誤 | M09 | — | 先確認主機時間正確（`date`）；**要先問**才可刪 `config/wazuh_indexer_ssl_certs/*` 重新產生 |
| D10 | Agent 憑證被 SOAR 撤銷中 | F10 | 呼叫入口網站 `/api/reset` 解除 | 通常是測試留下的；佈署驗收前應清除 |
| D11 | 工作卡在 running > 15 分鐘 | F11 | 重啟兩個執行器 | — |
| D12 | 程式碼比容器新 | F12 | `docker compose build` ＋ `up -d` | — |
| D13 | Agent 連不到模型 | M13 | — | 見 §4 M13 |
| D14 | 入口網站回報元件不健康／無回應 | F04 | 重啟對應服務 | — |
| D15 | `.env` 缺新版設定鍵 | F15 | 從 `.env.example` 補鍵（不改既有值）並 `up -d` | — |
| D16 | `.env` 憑證是預設值或空白 | M16 | — | 見 §4 M16 |
| D17 | 資料庫唯讀帳號密碼與 `.env` 不一致 | F17 | 以 `.env` 值 `ALTER ROLE agent_ro`，重建 toolproxy | 起因多半是 `.env` 被重新產生而資料庫是舊的 |
| D18 | 腳本是 CRLF 換行 | F18 | 轉回 LF、補執行權限 | `lab.sh` 本身壞掉時改用 `python3 tools/agentlab_doctor.py repair F18` |
| D19 | 安裝紀錄顯示網路下載失敗 | M19 | — | 見 §4 M19 |
| D20 | 連接埠被占用 | M20 | — | 見 §4 M20 |
| D21 | 上次驗收的安全控制項目未通過 | M21 | — | 見 §4 M21，**不可自動修** |

`./lab.sh repair auto` 會依上表自動套用所有 `F*`，最多 3 輪；同一修法套用後問題仍在就標為無效、不再重試（見 `results/repair-latest.json` 的 `ineffective_fixes`）。

## 3. 驗收項目（`B*`／`C*`，來自 `./lab.sh verify`）

| 代碼 | 內容 | 未通過時 |
|---|---|---|
| B01 | Docker 可用 | WSL（→ D01） |
| B02／B03 | 常駐容器都在跑、沒有反覆重啟（16 個，含第三章的 `websim`） | WSL（→ D03／D04） |
| B04 | `vm.max_map_count` | WSL（→ D02） |
| B05 | 磁碟 ≥ 20 GB（非必要） | WSL（→ D05） |
| B06 | Wazuh 已載入自訂規則（100901、100909、100910、100911、100913） | WSL（→ D06） |
| B07 | `.env` 憑證已是亂數 | M16 |
| B08 | Wazuh 弱點偵測已關閉（非必要） | 不可改 `wazuh_manager.conf`；回報 |
| B09 | 第三章資料面：程式碼倉已掛進閘道、跨會話筆記種子存在 | WSL（→ D08；仍失敗則 D12 重建 toolproxy） |
| B10 | 內容擷取移除網頁隱藏注入（3.3.2） | **M21**（安全控制） |
| B11 | 跨會話筆記以擁有者授權（3.4.2） | **M21** |
| C01–C04 | 入口網站、平台元件、護欄開啟、無撤銷 | WSL（C04 → D10） |
| C05 | 受治理 Agent 只連得到閘道與模型代理 | **M21**（網路隔離） |
| C06 | 對照組連得到不該碰的地方（展示對照） | WSL；仍失敗回報 |
| C07–C09、C14、C15 | 護欄：注入、誘餌遮蔽、工具參數、字元間距規避、外部網址 | **M21** |
| C10 | 模型代理白名單、拒絕雲端模型 | **M21** |
| C11 | 經模型代理連得到模型 | M13 |
| C12 | Wazuh 告警可查 | WSL（→ D07） |
| C13 | 良性冒煙測試（需模型） | M13（模型慢或不支援 tool calling 時回報耗時與錯誤，不要換模型） |

## 4. 需要人或要特別處理的情況（`M*`）

**M13 模型服務連不上**
1. 從 Windows 測：`Test-NetConnection <DGX的IP> -Port 11434`；從 WSL 測：`curl -s http://<DGX的IP>:11434/v1/models`。
2. 都不通 → 回報使用者檢查模型主機：Ollama 在線、`OLLAMA_HOST=0.0.0.0`、防火牆開 11434、`OLLAMA_NO_CLOUD=1`。你不可登入模型主機修改。
3. 通，但 C11 仍失敗 → 檢查 `.env` 的 `LLM_UPSTREAM`（不要加 `/v1`）與 `MODEL` 名稱是否與 `/v1/models` 列出的一致；可修改這兩個值後 `./lab.sh up`。
4. 模型清單裡沒有 `MODEL` → 回報使用者在模型主機 `ollama pull <MODEL>`。

**M16 `.env` 憑證是預設值**：**要先問**。處理方式是 `./install.sh --yes --fresh-env ...` 重新產生，接著執行 `./lab.sh repair F17` 同步資料庫唯讀密碼。

**M19 網路下載失敗**（DNS、Proxy、Docker Hub 速率限制）
1. WSL 內：`getent hosts registry-1.docker.io`、`curl -sI https://registry-1.docker.io/v2/`。
2. DNS 失敗 → 回報；不要自行改 `/etc/resolv.conf` 以外的系統網路設定。
3. `toomanyrequests` → 等 30 分鐘後重跑 `./lab.sh up`（最多 2 次），仍失敗回報。
4. 公司 Proxy 擋住 → 回報使用者提供 Proxy 設定；不要關閉 TLS 驗證。

**M20 連接埠被占用**
1. Windows：`Get-NetTCPConnection -LocalPort <埠> -State Listen | Select OwningProcess`，再 `Get-Process -Id <PID>`；WSL：`ss -ltnp | grep :<埠>`。
2. 回報是哪個程式，由使用者決定停用它，或改 `.env` 的 `PORTAL_PORT`／`GRAFANA_PORT`／`WAZUH_DASHBOARD_PORT`（改埠號後 Windows 防火牆規則與驗收腳本預設埠需人調整）。

**M21 安全控制未通過**：**停下來**。不要修改 `app/`、`policy.yaml`、Wazuh 規則、compose 網路設定或驗收條件。回報：哪一項、證據（報告的 `evidence`）、最近改過的檔案（`deploy-log.md`）。若是你先前修改佈署腳本造成的，可以還原你自己的修改後重新驗收。

**M04 記憶體不足**：**要先問**是否調高 `.wslconfig` 的 `memory`（64 GB 主機建議上限 44 GB）。

**M09 憑證錯誤**：先確認 Windows 與 WSL 時間正確（`date`）；**要先問**才可刪除 `config/wazuh_indexer_ssl_certs/*` 後 `./lab.sh up` 重新產生。

**INSTALL**：重跑 RUNBOOK 第 2 階段的安裝指令（同一組參數）；重跑是安全的，會沿用 `.env`。

---

## 5. Codex 在 Windows 上的已知狀況

| 狀況 | 處理 |
|---|---|
| 指令要求核准網路或提升權限 | 正常。安裝需要連網下載、建立防火牆規則；說明原因後請使用者核准 |
| `wsl` 輸出亂碼或字串比對失敗 | 腳本已設 `WSL_UTF8=1`；自行下的 `wsl` 指令也先 `$env:WSL_UTF8="1"` |
| 安裝很久沒有輸出 | 第一次下載約 8 GB 映像，可能 20 分鐘以上。不要中斷；另開指令看 `deploy-logs\install-windows-*.log` 或 WSL 內 `results/install-latest.log` 的最後幾行 |
| 指令執行逾時被中斷 | 改為分段：先 `install-windows.ps1` 跑到結束，再單獨執行驗收；重跑安裝是安全的 |
| 剛重開機後全部連不到 | 先登入 Windows（排程工作在登入後啟動 WSL），等 2 分鐘再 `.\repair-windows.ps1 -Auto` |
| 改了佈署腳本但沒效果 | WSL 跑的是複本：改完一定要 `.\install-windows.ps1 -Update`（P09 會偵測） |
| `lab.sh` 執行出現 `$'\r': command not found` | CRLF：`python3 tools/agentlab_doctor.py repair F18` |
| PowerShell 回 740「需要提升權限」 | Codex 部分版本的已知問題。照 `AGENTS.md`「沒辦法以系統管理員身分執行時」用 `Start-Process -Verb RunAs -Wait` 執行，結果從 `deploy-logs\` 讀 |
| 使用者帳號資料夾含中文，Codex 開不起來 | 社群回報的已知問題：設定使用者環境變數 `CODEX_HOME=C:\codex-home`（英文路徑）後重開 Codex，或改用英文名稱的 Windows 帳號 |

---

## 6. 一行安裝（`get.ps1`／`get.sh`）與 GitHub

| 狀況 | 原因 | 處理 |
|---|---|---|
| `Cannot download the kit` | 沒網路、公司 proxy 擋下、repo 不是公開、分支名稱打錯 | 瀏覽器開 `https://github.com/<owner>/<repo>` 確認看得到；`-Ref` 確認分支或 tag 存在；有 proxy 時先在瀏覽器測 `https://github.com` |
| 貼上指令後出現一堆紅字 `The term 'param' is not recognized`（param 前面有看不見的字元） | `get.ps1` 被存成含 BOM 的 UTF-8 | 維護者檢查 `get.ps1` 開頭是否有 BOM（位元組 EF BB BF），改存成無 BOM、純 ASCII 後送 PR |
| 一行指令開了新視窗後又關掉 | 使用者在 UAC 視窗按了「否」 | 重貼一次，按「是」；或直接用「終端機（系統管理員）」貼 |
| `git pull failed` | 維護用資料夾有未提交的改動或不在 `main` | `git status` 看是什麼；是 Codex 上次的修正就先完成第 5 階段 PR；不可直接丟棄改動，要先問 |
| `git push` 跳出 GitHub 登入視窗 | 第一次推送，Git Credential Manager 要授權 | 需要人：請使用者在瀏覽器登入並按「Authorize」 |
| `git push` 被拒（403） | 登入的 GitHub 帳號沒有這個 repo 的寫入權限 | 需要人：請 repo 擁有者把該帳號加為 Collaborator，或改由擁有者的帳號推送 |
| `gh: command not found` 或 `gh auth status` 失敗 | 沒裝 GitHub CLI 或未登入 | 不需要它也能完成：改給使用者 compare 網址建立 PR |
