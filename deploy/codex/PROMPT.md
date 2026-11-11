# 貼給 Codex 的指令

使用前：
1. 把套件解壓縮到 Windows 主機，例如 `C:\agentlab\agent-lab-starter`。
2. 以系統管理員身分開啟 ChatGPT（Codex）桌面程式，工作資料夾選這個資料夾，核准模式選「Ask for approval」。
3. 把下面方框裡的 `<…>` 換成實際值，整段貼給 Codex。

```text
請在這台 Windows 11 Pro 主機上佈署「AI Agent 治理藍隊實驗環境」，並用驗收腳本證明佈署成功。

開始前先完整讀過這兩個檔案，並嚴格照做：
- AGENTS.md（工作規則：不改套件、不碰考卷、不洩漏秘密、破壞性動作先問、用證據回報）
- deploy/codex/RUNBOOK.md（第 0 到第 4 階段的步驟與關卡）

參數：
- REPO_DIR = <C:\agentlab\agent-lab-starter>
- LLM_URL = <http://DGX的IP:11434>
- MODEL = <模型名稱，例如 gemma4:31b>
- HOST_IP = <這台主機的區網 IP；不確定就寫「請列出候選讓我選」>
- GUARD_MODEL = <留空，或本地防護模型名稱>

執行方式：
- 一次只做一個階段。每個階段結束時，告訴我執行了哪些指令、結束代碼、報告檔路徑和關鍵結果，等我說「繼續」再進下一階段。
- 任何會改變系統狀態的指令，執行前先把完整指令給我看。
- 遇到需要重新開機、需要我手動操作、或 RUNBOOK 寫「停」的情況，就停下來說明，不要自己想辦法繞過。
- 不要修改套件裡的任何檔案。你認為套件有問題時，把錯誤訊息和你的判斷告訴我。
- 最後依 RUNBOOK 第 4 階段的格式回報。
```

## 重新開機之後

安裝 WSL 後若要求重新開機（結束代碼 3010），重開機後以系統管理員身分重開 Codex，貼這段：

```text
我已經重新開機。請重新讀 AGENTS.md 與 deploy/codex/RUNBOOK.md，從第 2 階段重跑同一個安裝指令，參數與上次相同：
REPO_DIR = <…>  LLM_URL = <…>  MODEL = <…>  HOST_IP = <…>  GUARD_MODEL = <…>
```

## 只補跑驗收

模型主機稍後才就緒時：

```text
模型主機已就緒。請依 deploy/codex/RUNBOOK.md 第 3 階段執行 verify-windows.ps1 -Stage Post -WithModel，再依第 4 階段回報。
不要做其他變更。
```
