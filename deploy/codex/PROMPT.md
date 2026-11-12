# 貼給 Codex 的指令

使用前：
1. 把套件解壓縮到 Windows 主機，例如 `C:\agentlab\agent-lab-starter`。
2. 以系統管理員身分開啟 ChatGPT（Codex）桌面程式，工作資料夾選這個資料夾，核准模式選「Ask for approval」。
3. 把下面方框裡的 `<…>` 換成實際值，整段貼給 Codex。

```text
請在這台 Windows 11 Pro 主機上佈署「AI Agent 治理藍隊實驗環境」，遇到問題自己診斷、修復，直到驗收通過。

開始前先完整讀過這三個檔案，並嚴格照做：
- AGENTS.md（工作規則：自癒迴圈、允許自行做的動作、絕對禁止的事、要先問我的事、紀錄格式）
- deploy/codex/RUNBOOK.md（第 0 到第 4 階段與每一關的判斷）
- deploy/codex/TROUBLESHOOTING.md（每個錯誤代碼的意思與修法）

參數：
- REPO_DIR = <C:\agentlab\agent-lab-starter>
- LLM_URL = <http://DGX的IP:11434>
- MODEL = <模型名稱，例如 gemma4:31b>
- HOST_IP = <這台主機的區網 IP；不確定就寫「請列出候選讓我選」>
- GUARD_MODEL = <留空，或本地防護模型名稱>

執行方式：
- 依 RUNBOOK 一階段一階段做，每個階段結束時告訴我：執行的指令、結束代碼、報告檔路徑、關鍵結果。
- 任何步驟失敗，不要先停：照 AGENTS.md 的自癒迴圈，先 repair-windows.ps1 -Diagnose 看問題，再 -Auto 自動修，
  再查 TROUBLESHOOTING.md 處理剩下的項目，修完重新驗收。同一個問題最多處理 3 次。
- 只有這些情況停下來問我：需要重新開機、需要我手動操作、要刪除資料或環境、代碼是 M 開頭、安全控制項目（M21）未通過。
- 可以修正佈署腳本的錯誤，但不可以放寬任何安全控制或驗收條件；每個修改都寫進 deploy-logs\deploy-log.md（改了什麼、為什麼），
  改完先執行 install-windows.ps1 -Update 再驗收。
- 不要顯示 .env 裡的 token 與密碼；最後只回報操作 PIN。
- 最後依 RUNBOOK 第 4 階段的格式回報，包含「自動排除過的問題」與「我修改過的佈署腳本」。
```

## 重新開機之後

安裝 WSL 後要求重新開機（結束代碼 3010）時，重開機、登入後以系統管理員身分重開 Codex，貼這段：

```text
我已經重新開機。請重新讀 AGENTS.md、deploy/codex/RUNBOOK.md、deploy/codex/TROUBLESHOOTING.md，
從第 2 階段重跑同一個安裝指令，參數與上次相同；之後照常進行驗收與自癒：
REPO_DIR = <…>  LLM_URL = <…>  MODEL = <…>  HOST_IP = <…>  GUARD_MODEL = <…>
先讀 deploy-logs\deploy-log.md 了解上次做到哪裡。
```

## 環境出問題時（已經佈署過）

```text
環境好像有問題。請依 AGENTS.md 的自癒迴圈處理：先 repair-windows.ps1 -Diagnose，再 -Auto，
剩下的查 TROUBLESHOOTING.md。修好後執行 verify-windows.ps1 -Stage Post -WithModel，並依 RUNBOOK 第 4 階段回報。
```

## 套件換新版之後

```text
我把套件換成新版了（同一個資料夾）。請執行 install-windows.ps1 -Update 同步進 WSL，
再依 RUNBOOK 第 3 階段驗收與自癒，最後回報。不要重新安裝、不要重新產生 .env。
```
