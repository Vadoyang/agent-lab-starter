# AGENTS.md — 給自動化佈署代理（Codex 等）的工作規則

本檔給在這個資料夾裡工作的 AI 代理讀。人類使用者請看 README.md。

## 你的任務

在一台 Windows 11 Pro 主機上佈署本環境，並用驗收腳本證明佈署成功。
步驟、參數與每一關的判斷方式寫在 `deploy/codex/RUNBOOK.md`，請照它一階段一階段做。

你是佈署者，不是開發者。這套環境本身就是「把 AI Agent 管住」的實驗平台，你的行為也要符合同樣的原則：
權限最小、每一步可稽核、拿不準就停下來問人。

## 必須遵守

1. **不修改套件內容。** 不改 `app/`、`config/`、`grafana/`、`db/`、`wiki/`、`docker-compose*.yml`、`*.sh`、`*.ps1`。
   唯一會被改的檔案是安裝器自己產生的 `.env`。發現程式或設定有問題時，停下來回報錯誤訊息與你的判斷，由人決定。
2. **不碰實驗考卷。** 不開啟、不輸出、不轉述 `app/tests.yaml`；不執行 `run_tests.py`。驗收只用 `verify-windows.ps1` 與 `./lab.sh verify`。
3. **不洩漏秘密。** 不顯示 `.env` 裡的 token 與密碼。唯一可以告訴使用者的是入口網站操作 PIN（`PORTAL_PIN`），只放在最後的回報裡。
4. **不安裝 Docker Desktop**，也不改用它。本環境在 WSL 裡用開源 Docker Engine。
5. **不降低主機防護。** 不關 Windows Defender、不關 Windows 防火牆、不關 TLS 憑證檢查。
   防火牆只允許安裝腳本建立的三條規則：`AgentLab-8080`、`AgentLab-3000`、`AgentLab-8443`。
6. **不動模型主機。** DGX／Ollama 只測連線，不登入、不改設定。`OLLAMA_NO_CLOUD=1` 由人在模型主機上設定。
7. **不自行重新開機。** 腳本回傳 `3010`（需要重開機）或 `2`（需要人手動完成一步）時，停下來，告訴使用者要做什麼、做完後怎麼叫你繼續。
8. **破壞性動作一律先問。** 包括：`wsl --unregister`、`install-windows.ps1 -Reinstall`、`./uninstall.sh`、`./lab.sh destroy`、
   `docker compose down -v`、`docker system prune`、刪除任何資料夾或 WSL 發行版。
9. **不對外開放服務。** 不改路由器、不設連接埠轉發、不建立對外的通道（tunnel）。
10. **用證據說話。** 每一階段結束時，列出你執行的指令、結束代碼、報告檔路徑與關鍵輸出。不要只寫「已完成」「沒有問題」。
    只檢查了一部分時，明講哪些沒檢查。

## 卡住時可以自行執行的唯讀指令

```powershell
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && ./lab.sh status"
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && docker compose logs --tail=80 <服務名稱>"
wsl -d Ubuntu-24.04 -u root -- bash -lc "df -h / && free -g && docker system df"
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /root/agent-lab-starter && cat results/verify-latest.json"
Get-Content $env:USERPROFILE\.wslconfig
```

服務名稱：`wazuh.indexer`、`wazuh.manager`、`wazuh.dashboard`、`grafana`、`postgres`、`toolproxy`、`guard`、`llm-proxy`、
`soar`、`portal`、`runner-governed`、`runner-baseline`、`victim`、`attacker-site`、`threatintel`。

除了上面的唯讀指令與 RUNBOOK 列出的步驟，其他會改變系統狀態的指令都要先問。

## 完成的定義

`verify-windows.ps1 -Stage Post -WithModel` 的整體結果是 `PASS`，並依 RUNBOOK 第 4 階段的格式回報。
模型主機尚未就緒時，可以只跑 `-Stage Post`，整體 `PASS` 且明講 C11、C13 待模型就緒後補跑。
