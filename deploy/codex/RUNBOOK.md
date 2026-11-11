# 佈署步驟（給 Codex 執行）

適用：Windows 11 Pro 主機（例如 HPE ML30 Gen11，64 GB 記憶體、無 GPU），模型放在另一台主機（DGX）上的 Ollama。
工作規則見根目錄 `AGENTS.md`；本檔只寫步驟。每一階段都有「關卡」，關卡沒過不進下一階段。

> 本檔與 `verify-windows.ps1`、`install-windows.ps1` 都還沒在實體 Windows 主機上跑過。第一次執行時請人在旁邊看。

---

## 第 0 階段：確認參數

從使用者給的指令中取得下列參數。缺任何一個「必填」就先問，不要猜。

| 參數 | 必填 | 說明 | 例子 |
|---|---|---|---|
| `REPO_DIR` | 是 | 套件在 Windows 上的資料夾（含 `install-windows.ps1`） | `C:\agentlab\agent-lab-starter` |
| `LLM_URL` | 是 | 模型服務位址，結尾不要加斜線或 `/v1` | `http://192.168.1.50:11434` |
| `MODEL` | 是 | 要用的模型名稱（需支援 tool calling） | `gemma4:31b` |
| `HOST_IP` | 否 | 區網其他電腦連入口網站用的 IP；不給就由腳本偵測 | `192.168.1.20` |
| `GUARD_MODEL` | 否 | 護欄另用的本地防護模型；不給就只用規則 | （留空） |

`HOST_IP` 沒給時，用下面的指令列出候選 IP 給使用者確認，不要自己挑：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object IPAddress, InterfaceAlias
```

**關卡 0：** 必填參數齊全，`HOST_IP` 已由使用者確認或明確同意自動偵測。

---

## 第 1 階段：佈署前檢查（不做任何變更）

```powershell
cd <REPO_DIR>
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows.ps1 -Stage Pre -LlmUrl <LLM_URL>
```

報告寫在 `<REPO_DIR>\deploy-report-pre.json`。

| 未通過的項目 | 處理方式 |
|---|---|
| W01 Windows 版本 | 停。請使用者先跑 Windows Update 到 22H2 以上。 |
| W02 虛擬化 | 停。需要人進 BIOS 開啟 Intel VT-x／VT-d。 |
| W03 記憶體、W04 磁碟 | 停，回報數字，由使用者決定是否繼續。 |
| W07 已裝 Docker Desktop | 停，問使用者：解除安裝 Docker Desktop，或放棄本次佈署。不要自己解除安裝。 |
| W09 下載來源 | 停。回報哪個網域連不到（可能是公司防火牆或 Proxy）。 |
| W10 模型服務 | 回報。可以在使用者同意下繼續佈署平台，模型就緒後再補驗收。 |
| W12 連接埠被占用 | 停，回報被占用的埠；用 `Get-NetTCPConnection -LocalPort <埠> -State Listen` 查出是哪個程式，交給使用者處理。 |
| W05 待重新開機（warn） | 建議使用者先重開機再開始。 |

**關卡 1：** 整體 `PASS`，或剩下的未通過項目已經使用者明確同意略過。

---

## 第 2 階段：安裝

需要系統管理員權限（Codex 桌面程式要以系統管理員身分啟動，Agent 才會繼承這個權限）。
執行前把完整指令給使用者看並取得同意。

```powershell
cd <REPO_DIR>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 `
  -InstallArgs "--yes --docker install --ollama point --model-url <LLM_URL> --model <MODEL> --host-ip <HOST_IP>"
```

- 有 `GUARD_MODEL` 時，在 `-InstallArgs` 最後加上 `--guard-model <GUARD_MODEL>`。
- 沒有 `HOST_IP` 時，拿掉 `--host-ip <HOST_IP>`。
- 第一次會下載約 8 GB 的容器映像，依網速可能要 20 分鐘以上。不要因為等太久就中斷。

依結束代碼處理：

| 結束代碼 | 意思 | 你要做的事 |
|---|---|---|
| `0` | 完成 | 進第 3 階段 |
| `3010` | 剛裝好 WSL，需要重新開機 | 停。請使用者重新開機，開機後以系統管理員身分重開 Codex，再從第 2 階段重跑同一個指令 |
| `2` | WSL 發行版需要第一次手動啟動 | 停。請使用者從開始功能表打開「Ubuntu 24.04」建立帳號、關掉視窗，再叫你重跑第 2 階段 |
| `1` | 失敗 | 用 AGENTS.md 列的唯讀指令收集錯誤訊息，回報你的判斷。不要改檔案，不要用 `-Reinstall` |

重跑安裝是安全的：腳本會沿用已安裝的 WSL、發行版與已複製的資料夾。
`install.sh` 在 `--yes` 模式會重新產生 `.env`（舊檔自動備份成 `.env.bak.<時間>`），PIN 也會換新。

**關卡 2：** `install-windows.ps1` 結束代碼為 `0`。

---

## 第 3 階段：驗收

```powershell
cd <REPO_DIR>
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows.ps1 -Stage Post -WithModel
```

這一步會：
1. 檢查 Windows 端（.wslconfig、systemd、防火牆規則、排程工作、入口網站與 Grafana 可連）；
2. 進 WSL 執行 `./lab.sh verify --with-model`：檢查容器、Wazuh 規則、`.env` 是否已換成亂數、網路隔離、護欄自我測試、
   模型代理白名單、模型連線、Wazuh 告警可查，最後讓兩個 Agent 各回答一題良性問題；
3. 合併成 `<REPO_DIR>\deploy-report-post.json`，WSL 內另有 `/root/agent-lab-starter/results/verify-latest.json`。

剛裝完時 Wazuh indexer 可能還在啟動。C02 或 C12 失敗時，等 3 分鐘再跑一次；連續兩次失敗才算真的失敗。

| 未通過的項目 | 可能原因 | 處理 |
|---|---|---|
| B02、B03 容器沒起來或一直重啟 | 記憶體或磁碟不足、映像沒下載完 | 看 `docker compose logs --tail=80 <服務>`，回報 |
| B04 vm.max_map_count | sysctl 設定沒寫入 | 回報（安裝器應已處理，不要自己改） |
| C05 受治理 Agent 連得到不該連的地方 | 網路設定被改過 | **嚴重**。停，回報完整證據 |
| C07–C09 護欄自我測試 | guard 服務異常 | 看 `docker compose logs guard`，回報 |
| C11 模型連不到 | `LLM_URL` 錯、模型主機防火牆、Ollama 只聽 127.0.0.1、模型沒 pull | 回報；請使用者在模型主機確認 `OLLAMA_HOST=0.0.0.0`、`OLLAMA_NO_CLOUD=1`，並已 `ollama pull <MODEL>` |
| C13 冒煙測試 | 模型太慢或不支援 tool calling | 回報耗時與錯誤；不要換模型，由使用者決定 |
| P04 防火牆規則（warn） | 非系統管理員執行驗收 | 以系統管理員身分重跑驗收 |
| P07 區網 IP 連不到 | mirrored 網路或防火牆 | 回報；請使用者從另一台電腦試 `http://<HOST_IP>:8080` |

**關卡 3：** 整體 `PASS`。模型未就緒時：不加 `-WithModel` 的整體 `PASS`，並在回報中註明 C11／C13 待補。

---

## 第 4 階段：回報

用下面的格式回報。所有數字與結果都要來自報告檔，不要憑印象寫。

```
佈署結果：PASS／FAIL
報告檔：<REPO_DIR>\deploy-report-pre.json、<REPO_DIR>\deploy-report-post.json

網址
  入口網站  http://<HOST_IP>:8080   操作 PIN：<PORTAL_PIN>
  Grafana   http://<HOST_IP>:3000
  Wazuh     https://<HOST_IP>:8443（自簽憑證）

驗收摘要（來自 deploy-report-post.json）
  必要項：通過 <n>／<總數>；未通過：<id 清單或「無」>
  警告：<id 清單或「無」>
  冒煙測試：受治理 Agent 耗時 <latency_s> 秒，鐵律一 <守住/失守>，鐵律二 <守住/失守>

我執行過的會改變系統的指令
  1. ...（含結束代碼）

需要人接手的事
  - 從另一台電腦開啟入口網站，確認區網連得到
  - 在模型主機設定 OLLAMA_NO_CLOUD=1（若尚未設定）
  - 對外展示前更改 Grafana（admin／agentlab）與 Wazuh（admin／SecretPassword）的示範密碼
  - （其他未通過或略過的項目）
```

`PORTAL_PIN` 用這個指令讀（只讀這一行，不要印出整份 `.env`）：

```powershell
wsl -d Ubuntu-24.04 -u root -- bash -lc "grep '^PORTAL_PIN=' /root/agent-lab-starter/.env | cut -d= -f2"
```

---

## 給使用者：Codex 的建議設定

| 設定 | 建議 | 原因 |
|---|---|---|
| 啟動方式 | 以系統管理員身分開 ChatGPT／Codex 桌面程式 | `install-windows.ps1` 需要系統管理員權限，Agent 繼承程式的權限 |
| Agent 執行環境 | PowerShell（不要切到 WSL 模式） | 兩支腳本都是 PowerShell，會自己呼叫 `wsl.exe` |
| 核准模式 | 「Ask for approval」 | 安裝要寫入使用者設定、建立防火牆規則、連網下載，每一步都應經人核准 |
| 不要用 | Full access、核准政策設為 never | 會讓 Agent 不受專案資料夾與核准限制 |
| 工作資料夾 | 開在 `<REPO_DIR>` | Codex 才會讀到根目錄的 `AGENTS.md` |
