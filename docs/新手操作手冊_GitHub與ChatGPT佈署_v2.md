# 新手操作手冊：把安裝包放上 GitHub，讓 ChatGPT 自動佈署並修正

版本 v2（2026-11-12）。本手冊由 Claude 起草，請在第一次實際操作後依實況修正。

v2 變更：新增 B 部分「準備模型主機（GB10）」——說明模型在哪裡指定、為什麼 Ollama 不需要帳號密碼、GB10 要做的四件事；原 B～F 部分順延為 C～G；安裝問答與 ChatGPT 參數改為「模型名稱必須和 GB10 上 `ollama list` 一致」；安裝程式與驗收新增「GB10 是否已下載該模型」的檢查。

適用對象：不熟電腦操作的人。每一步都寫了「要按哪裡」與「會看到什麼」。
標示〔待查證〕的地方是畫面或規定可能已經改變、需要你實際看一下的部分。

---

## 0. 先看懂整體：誰負責什麼

```
              ┌─────────────────────────────┐
              │  GitHub（安裝包的正式版本）   │
              │  github.com/Vadoyang/        │
              │      agent-lab-starter       │
              └──────┬──────────────▲───────┘
   一行指令下載安裝   │              │  ChatGPT 修好後送「PR」，你按 Merge 才會更新
                     ▼              │
  ┌──────────────────────┐   ┌──────┴─────────────────────────────┐
  │ 任何人的 Win 11 Pro   │   │ 實驗主機（HPE ML30，Win 11 Pro）     │
  │ 貼一行指令就自動安裝   │   │ ChatGPT（Codex）在這裡安裝、驗收、    │
  │ （像 T-GUARD）        │   │ 遇到問題自己修，修好的腳本送回 GitHub │
  └──────────┬───────────┘   └──────┬─────────────────────────────┘
             │  只送模型呼叫（經模型代理，只放行指定的模型）
             ▼                      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ 模型主機 GB10：Ollama 只負責算力（模型由實驗主機的 .env 指定）  │
  └──────────────────────────────────────────────────────────────┘
```

| 角色 | 做什麼 |
|---|---|
| GitHub | 放安裝包的「正式版」。大家下載的都是這一份 |
| 一行指令（`get.ps1`） | 使用者在自己電腦貼上後，自動去 GitHub 下載安裝包並安裝 |
| ChatGPT（Codex） | 在實驗主機上幫你執行安裝、驗收；出錯時自己診斷、修復；修到安裝腳本時，開一個「修正提案（PR）」送回 GitHub |
| 模型主機（GB10） | 只跑 Ollama 提供算力；要先下載好模型、開放給實驗主機連線（B 部分，由你或管 GB10 的人做，ChatGPT 不會碰 GB10） |
| 你 | 建 GitHub 專案（一次）、準備 GB10（一次）、在 ChatGPT 問你時按「核准」或「拒絕」、在 GitHub 上看過修正提案後按「Merge」 |

為什麼 ChatGPT 不能直接改正式版：它改錯的話，之後每個人裝到的都是錯的版本。所以它只能「提案」，由你按下合併；GitHub 也會自動檢查它是不是只改了允許改的檔案（綠勾＝通過，紅叉＝不要合併）。

---

## A. 把安裝包放上 GitHub（只做一次）

你已經有 GitHub 帳號 `Vadoyang`，從 A1 開始。

### A1 建立一個空的專案（repository）

1. 用瀏覽器打開 <https://github.com>，確認右上角是你的頭像（已登入）。
2. 按右上角的 **「+」** → **「New repository」**。
3. 填寫：
   - **Repository name**：`agent-lab-starter`（請完全照打；一行指令裡寫的就是這個名字）
   - **Description**：可留空
   - 選 **Public**（公開）。理由：一行指令要能在別人電腦上直接下載，私人專案下載不到。
   - **不要**勾「Add a README file」、「.gitignore」、「license」（安裝包裡已經有了，勾了會衝突）。
4. 按綠色 **「Create repository」**。看到一頁有「Quick setup」字樣的說明頁，就是建好了。

> 公開前已確認：安裝包裡沒有任何真正的密碼或 token（`.env` 不在安裝包裡，每台主機安裝時自己產生）。
> 裡面有 Grafana（admin／agentlab）與 Wazuh（admin／SecretPassword）的**示範預設密碼**，對外展示前要改掉；這兩組本來就是公開的預設值。

### A2 把安裝包內容放進去（二選一）

**方法一（建議）：交給 Claude 推上去。**
回到這個對話告訴我「repo 建好了」。我會把完整版本歷史推上去，作者 email 會改成 GitHub 的匿名信箱，不公開你的個人 email。
如果我這邊沒有權限推送（GitHub 授權只開放給部分專案），我會告訴你，改用方法二。

**方法二：用網頁上傳。**
1. 把 `agent-lab-starter-github.zip` 解壓縮（在檔案上按右鍵 →「解壓縮全部」），得到 `agent-lab-starter` 資料夾。
2. 回到 A1 建好的那一頁，找到 **「uploading an existing file」** 連結並點它。
3. 打開解壓縮後的 `agent-lab-starter` 資料夾，按 `Ctrl+A` 全選**裡面的所有檔案和資料夾**，拖進瀏覽器的上傳區。
   （拖的是「裡面的東西」，不是外層的 `agent-lab-starter` 資料夾本身。）
4. 等檔案清單跑完，最下面的綠色按鈕（**「Commit changes」**）按下去。
5. GitHub 網頁一次最多上傳 100 個檔案、每個檔案最大 25 MiB〔已查證，GitHub 說明文件〕；本安裝包約 80 個檔案、最大的檔案不到 1 MB，一次傳得完。若被拒絕，分兩次拖（先拖 `app`、`config`、`docs`，再拖其餘）。

### A3 確認放好了

1. 打開 <https://github.com/Vadoyang/agent-lab-starter>，應該看到 `get.ps1`、`install-windows.ps1`、`AGENTS.md`、`app`、`docs` 等檔案。
2. 確認看得到 `.github` 資料夾與 `.env.example` 檔（名稱開頭是點的檔案也要在）。
3. 在瀏覽器打開 <https://raw.githubusercontent.com/Vadoyang/agent-lab-starter/main/get.ps1>，看到一頁英文程式碼就代表一行指令可以用了。

---

## B. 準備模型主機 GB10（只做一次，ChatGPT 不會碰這台）

### 先看懂：模型在哪裡指定？為什麼沒有問 Ollama 帳號密碼？

- **用哪個模型，是實驗主機決定的**。安裝時問的「模型名稱」（或給 ChatGPT 的 `MODEL` 參數）會寫進實驗主機的 `.env`，
  模型代理只放行這個名稱（加上護欄模型，若有設定）。GB10 只負責「跑」，不決定用哪個。
  入口網站的 Ollama 元件卡片會顯示目前指定的模型名稱。
- **Ollama 的 API 沒有帳號密碼**。官方說明裡，本機 Ollama 伺服器沒有登入或金鑰的設定；預設只讓自己（127.0.0.1）連，
  要讓別台連就得改設定〔已查證，Ollama FAQ〕。所以安裝程式不會、也不需要問你 Ollama 帳密。
- **「Ollama 帳號」（登入 ollama.com）跟這裡無關**。它只用在推送模型、下載私有模型、使用 Ollama 雲端模型〔已查證〕。
  雲端模型會把提示送到 Ollama 的伺服器，違反「敏感資料不外送」，所以我們要把它關掉。
- `.env` 裡的 `LLM_API_KEY=ollama` 只是佔位字：程式送出請求時格式上一定要帶一個金鑰欄位，Ollama 不會檢查。

沒有帳密代表**區網裡任何連得到 GB10 的電腦都能用它**，甚至能刪除或更換模型。所以 B4 要用防火牆限制「只有實驗主機能連」。

### B1 打開 GB10 的終端機

- 在 GB10 前面操作：登入桌面後打開「Terminal」（終端機）。
- 或從另一台電腦連線：在 Windows 終端機輸入 `ssh <GB10帳號>@<GB10的IP>`，第一次會問是否信任，輸入 `yes`，再輸入密碼。

先確認 Ollama 是用系統服務方式安裝的：
```bash
systemctl status ollama --no-pager
```
看到綠色 **`active (running)`** 就繼續 B2。按 `q` 離開畫面。
若顯示 `could not be found`，代表 Ollama 不是用標準方式安裝（例如裝在容器裡），B2 的設定方式不同，請問當初安裝 Ollama 的人。

### B2 讓實驗主機連得到、並關閉雲端功能

一次貼上這三行（會問你 GB10 帳號的密碼）：
```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\nEnvironment="OLLAMA_NO_CLOUD=1"\n' | sudo tee /etc/systemd/system/ollama.service.d/zz-agentlab.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```
- `OLLAMA_HOST=0.0.0.0:11434`：讓別台電腦連得到（預設只有 GB10 自己能連）。
- `OLLAMA_NO_CLOUD=1`：關掉 Ollama 雲端模型〔已查證，Ollama FAQ〕。
- 檔名開頭 `zz-` 是為了讓這份設定排在最後、蓋過舊設定。

確認生效（兩個設定都要出現）：
```bash
systemctl show ollama --property=Environment
```

### B3 下載要用的模型

```bash
ollama pull gemma4:31b
ollama list
```
- `gemma4:31b` 是本套件的預設，在 Ollama 官方模型庫查得到〔已查證〕。要用別的模型就換名稱，但必須支援工具呼叫（tool calling）。
  `ollama show <名稱>` 的輸出裡若有 `tools`，代表支援〔推論，依 Ollama 的顯示格式〕。
- 下載大小視模型而定，可能要一段時間。
- **記下 `ollama list` 顯示的完整名稱**（含冒號後面的標籤），之後安裝或給 ChatGPT 時要一字不差。
  只寫 `gemma4` 等於 `gemma4:latest`，跟 `gemma4:31b` 是不同的東西。

### B4 只讓實驗主機連（先跟管 GB10 的人確認）

先查實驗主機的 IP：在實驗主機的終端機輸入 `ipconfig`，找「IPv4 位址」，例如 `192.168.1.20`。

再到 GB10 查防火牆狀態：
```bash
sudo ufw status
```

**情況一：顯示 `Status: active`**（防火牆已開）→ 貼上（把 IP 換成實驗主機的）：
```bash
sudo ufw allow from 192.168.1.20 to any port 11434 proto tcp
sudo ufw deny 11434/tcp
sudo ufw status numbered
```
清單裡 `ALLOW` 那一行要排在 `DENY` 前面。若原本就有一條「11434 ALLOW Anywhere」，用 `sudo ufw delete <編號>` 刪掉。

**情況二：顯示 `Status: inactive`**（防火牆沒開）→ **不要直接開**。一開啟，所有沒放行的連線都會被擋，
包括你正在用的 SSH 和 GB10 提供給別人的其他服務。請先和管 GB10 的人確認要放行哪些服務，順序是：
```bash
sudo ufw allow OpenSSH                       # 先放行 SSH，不然遠端連線會被切斷
# （其他要保留的服務也在這裡先放行）
sudo ufw allow from 192.168.1.20 to any port 11434 proto tcp
sudo ufw deny 11434/tcp
sudo ufw enable
```

> 注意：其他人若原本直接用 GB10 的 Ollama，做完 B4 就連不到了，請先在團隊內講好。
> 若 GB10 前面另外加了需要 token 的反向代理，可以把實驗主機 `.env` 的 `LLM_API_KEY` 改成那個 token，程式會自動帶上〔推論，依程式碼〕。

### B5 從實驗主機測試

在**實驗主機**的終端機貼上（IP 換成 GB10 的）：
```powershell
curl.exe -s http://<GB10的IP>:11434/v1/models
```
看到一串文字裡有 `"id":"gemma4:31b"`（你下載的名稱）就成功了。再從**另一台電腦**試同一行，應該連不到（代表 B4 生效）。

做完 B 部分，你手上會有兩個值，之後安裝或交給 ChatGPT 時要用：

| 值 | 例子 |
|---|---|
| 模型服務位址 | `http://<GB10的IP>:11434`（結尾不要加 `/` 或 `/v1`） |
| 模型名稱 | `ollama list` 顯示的完整名稱，例如 `gemma4:31b` |

---

## C. 一般使用者：在自己電腦上用一行指令安裝（像 T-GUARD）

需要：Windows 11 Pro（22H2 以上）、16 GB 以上記憶體（建議 64 GB）、可以上網，以及照 B 部分準備好的模型主機（GB10）。

### C1 打開系統管理員終端機

1. 在螢幕左下角的 **開始按鈕（Windows 標誌）上按右鍵**。
2. 選 **「終端機 (系統管理員)」**（有些電腦顯示「Windows PowerShell (系統管理員)」）。
3. 跳出「是否允許此應用程式變更您的裝置？」→ 按 **「是」**。
4. 出現一個黑色或藍色視窗，裡面有閃爍的游標，就是終端機。

### C2 貼上這一行，按 Enter

```powershell
irm https://raw.githubusercontent.com/Vadoyang/agent-lab-starter/main/get.ps1 | iex
```

（在終端機裡按滑鼠右鍵就是貼上。）

你會看到幾行開頭是 `[agentlab]` 的英文，代表它正在從 GitHub 下載安裝包到 `C:\agentlab\agent-lab-starter`，接著改成中文的安裝畫面。

### C3 第一次會要求重新開機

畫面出現 **`RESTART NEEDED`**（或中文「需要重新開機」）時：
1. 存好其他工作，重新開機。
2. 登入後重複 **C1、C2**：貼**同一行**指令。它會從剛才停下的地方接著做。

如果出現 **`ONE MANUAL STEP`**：從開始功能表打開「Ubuntu 24.04」，依畫面設定一個英文使用者名稱與密碼，關掉視窗，再貼同一行。

### C4 回答兩個問題

安裝程式會用中文問：

| 問題 | 選哪個 |
|---|---|
| 這台機器的 Docker 狀態？ | 選 **2**：尚未安裝，請自動幫我裝【建議】（裝的是開源 Docker Engine，不是 Docker Desktop） |
| 模型服務要怎麼準備？ | 選 **1**：我已經有 Ollama／vLLM，指過去就好 |
| 模型服務位址 | 輸入 B5 表格裡的位址，例如 `http://192.168.1.50:11434` |
| 模型名稱 | 輸入 GB10 上 `ollama list` 顯示的完整名稱，例如 `gemma4:31b`（預設就是這個，相同就直接按 Enter） |
| 這台主機對外的 IP | 通常直接按 Enter |

填完模型名稱後，安裝程式會立刻去 GB10 確認：看到「[完成] 模型主機已有 …」就對了；看到「[注意] … 還沒有 …」代表名稱打錯或 GB10 還沒下載，安裝會繼續，但之後 Agent 無法作答，請回 B3 處理。

第一次要下載約 8 GB，可能 20 分鐘以上，**不要關掉視窗**。

### C5 完成

最後看到 **`DONE`** 與網址、操作 PIN。用瀏覽器打開 `http://<這台電腦的IP>:8080` 就是入口網站。

### C6 之後要更新

再做一次 C1、C2（貼同一行）。設定、紀錄、憑證都會保留，只更新程式。

### C7 安裝失敗時

1. 畫面最後會寫 `Install did not finish`。先試：
   ```powershell
   cd C:\agentlab\agent-lab-starter
   .\repair-windows.ps1 -Auto
   ```
2. 還是不行：把 `C:\agentlab\agent-lab-starter\deploy-logs` 整個資料夾壓縮（右鍵 →「壓縮成 ZIP 檔」）寄給維護者。
   維護者把它交給 ChatGPT 分析（見 D 部分的「情境五」）。紀錄檔裡不含密碼與 token。

---

## D. 實驗主機：讓 ChatGPT（Codex）當你的佈署助手

這部分只在實驗主機（HPE ML30）上做。和 B 的差別是：這裡用 Git 下載，ChatGPT 修好的東西才能送回 GitHub。

### D1 安裝 Git

1. 照 C1 打開「終端機 (系統管理員)」。
2. 貼上，按 Enter：
   ```powershell
   winget install --id Git.Git -e --source winget
   ```
   第一次用 winget 可能問你是否同意條款，輸入 `Y` 按 Enter。看到「已成功安裝」即可。
3. **關掉終端機視窗，重新打開一次**（照 C1），新安裝的 Git 才會生效。

（選用）安裝 GitHub CLI，讓 ChatGPT 能自動建立修正提案；不裝也可以，它會改給你一個網址自己按：
```powershell
winget install --id GitHub.cli -e --source winget
```
裝好後關掉重開終端機，執行 `gh auth login`，依序選 **GitHub.com → HTTPS → Y → Login with a web browser**，
把畫面上的 8 碼代碼複製下來，按 Enter 會開瀏覽器，貼上代碼並按 **Authorize**。

### D2 用 Git 下載維護用的安裝包

在終端機貼上：
```powershell
git clone https://github.com/Vadoyang/agent-lab-starter.git C:\agentlab\agent-lab-starter
```
看到 `done.` 就好了。

> 如果這台主機之前已經用一行指令（C 部分）裝過，`C:\agentlab\agent-lab-starter` 已經存在，上面的指令會失敗。
> 先在檔案總管把那個資料夾改名成 `agent-lab-starter-old`，再執行一次。已經裝好的環境不受影響。

### D3 安裝 ChatGPT（Codex）桌面程式

1. 打開「Microsoft Store」，搜尋 **Codex**，按「取得」或「安裝」。
   也可以在終端機執行：`winget install --id 9PLM9XGG6VKS -s msstore`（OpenAI 文件提供的安裝方式）。
2. 打開後用你的 ChatGPT 帳號登入。需要的 ChatGPT 方案〔待查證〕：若登入後不能使用，請確認你的方案包含 Codex。

> 已知狀況：Windows 使用者名稱是中文時，Codex 可能打不開。解法：
> 開始 → 搜尋「編輯您帳戶的環境變數」→ 使用者變數按「新增」→ 名稱 `CODEX_HOME`、值 `C:\codex-home` → 確定 → 重開 Codex。

### D4 以系統管理員身分開啟 Codex

安裝 WSL、建立防火牆規則需要系統管理員權限，Codex 會繼承你開啟它的權限。

1. 按開始，搜尋 **Codex**。
2. 在搜尋結果上**按右鍵** → **「以系統管理員身分執行」** → 按 **「是」**。

### D5 打開安裝包資料夾

1. 在 Codex 裡按 **「Add new project」**（或按 `Ctrl+O`）。
2. 選 `C:\agentlab\agent-lab-starter`，按「選擇資料夾」。
   Codex 會自動讀到資料夾裡的 `AGENTS.md`（給它的工作規則）。

### D6 設定權限模式

1. 在輸入框**下方**找到權限選項，選 **「Ask for approval」**（每個會修改系統、連網的動作都先問你）。
2. **不要**選「Full access」，也不要把核准設成 never。
3. 設定裡的 Agent 保持預設的 **Windows native（PowerShell）**，不要切到 WSL。

### D7 貼上第一次佈署的指令

1. 打開 `C:\agentlab\agent-lab-starter\deploy\codex\PROMPT.md`（可以用記事本），複製「一、第一次佈署」方框裡的整段文字。
2. 貼到 Codex 的輸入框，把 `< >` 換成實際的值：

| 參數 | 填什麼 | 例子 |
|---|---|---|
| REPO_DIR | 照抄 | `C:\agentlab\agent-lab-starter` |
| LLM_URL | B5 表格裡的模型服務位址 | `http://192.168.1.50:11434` |
| MODEL | GB10 上 `ollama list` 顯示的完整名稱（一字不差） | `gemma4:31b` |
| HOST_IP | 不知道就寫「請列出候選讓我選」 | |
| GUARD_MODEL | 留空 | |

3. 按送出。

### D8 過程中你要做的事

Codex 會一階段一階段做，每一個動作跳出核准時：

| 看到它要做的事 | 你要怎麼按 |
|---|---|
| 執行 `verify-windows.ps1`、`install-windows.ps1`、`repair-windows.ps1`、`lab.sh`、`wsl`、`docker compose` | 核准 |
| 連網下載（Docker、映像、套件）、建立 `AgentLab-` 開頭的防火牆規則 | 核准 |
| 修改安裝腳本（它會先說明原因） | 核准；它會把改了什麼寫進 `deploy-logs\deploy-log.md` |
| `git switch -c codex/...`、`git commit`、`git push -u origin codex/...`、`gh pr create` | 核准 |
| 關閉 Windows Defender、關防火牆、對外開通道（tunnel） | **拒絕** |
| 刪除資料：`wsl --unregister`、`-Reinstall`、`docker volume rm`、`down -v`、`--fresh-env` | **拒絕**，除非你清楚要重來 |
| 修改 `app\`、`config\`、`docker-compose`、`.github\` 裡的檔案 | **拒絕**（那是安全控制，規則禁止它改） |
| `git push` 到 `main`、`--force`、自己合併 PR | **拒絕** |
| 顯示 `.env` 的內容 | **拒絕**（裡面是密碼與 token） |
| 要你提供 Ollama 帳號密碼、或要登入 GB10 | **拒絕**（Ollama 沒有帳密；規則禁止它碰 GB10） |

它停下來找你的幾種情況：
- **要重新開機**：重開機 → 登入 → 照 D4、D5 重開 Codex → 貼 PROMPT.md 的「二、重新開機之後」。
- **要你打開 Ubuntu 一次**：照 C3 的說明做，回來跟 Codex 說「好了」。
- **第一次推送到 GitHub 跳出登入視窗**：在瀏覽器登入 GitHub、按 **Authorize**。
- **GB10 還沒有指定的模型（W13 或 M13）**：照 B3 在 GB10 下載，或告訴它改用 `ollama list` 裡已有的名稱。
- **代碼是 M 開頭或安全項目（M21）沒過**：它不會自己硬修，會給你證據。把它的回報貼回這個對話給我看。

### D9 完成時你會收到

Codex 依固定格式回報：佈署結果（PASS／FAIL）、入口網站網址與操作 PIN、驗收數字、自動排除過的問題、改過的腳本、PR 網址。
請用**另一台電腦**的瀏覽器打開入口網站網址，確認區網連得到。

### D10 審核並合併 ChatGPT 的修正提案（PR）

只有 Codex 改過安裝腳本時才會有這一步。

1. 打開 Codex 給你的 PR 網址（或 <https://github.com/Vadoyang/agent-lab-starter/pulls>，點最上面那一筆）。
   如果它給的是「compare」網址，打開後按綠色 **「Create pull request」**，再按一次 **「Create pull request」**。
2. 等頁面下方的檢查跑完（約 1 分鐘）：
   - **綠色勾勾**（All checks have passed）→ 繼續。
   - **紅色叉叉** → **不要合併**。點「Details」，把畫面內容貼給 Codex 或貼回這個對話。
3. 點上方的 **「Files changed」**，確認改的都是安裝相關的檔案（`.ps1`、`.sh`、`deploy/codex/` 裡的 `.md`、`tools/agentlab_doctor.py`）。看不懂內容沒關係，自動檢查已經擋掉不該改的檔案；有疑慮就把網址貼給我看。
4. 回到「Conversation」分頁，按綠色 **「Merge pull request」** → **「Confirm merge」**。
5. 回到 Codex，貼 PROMPT.md 的「四、我在 GitHub 合併了 PR」，讓它把實驗主機也更新到正式版。

從這一刻起，所有人用一行指令安裝，拿到的都是修好的版本。

---

## E. 日常情境：貼哪一段

| 情況 | 在哪裡做 | 做法 |
|---|---|---|
| 第一次佈署實驗主機 | Codex | PROMPT.md「一」 |
| 佈署中途要求重開機 | Codex | 重開機後貼「二」 |
| 實驗主機出問題（網頁打不開、服務掛掉） | Codex | 貼「三」，寫一句你看到的狀況 |
| 你在 GitHub 合併了 PR | Codex | 貼「四」 |
| 別人用一行指令安裝失敗，寄來 deploy-logs | Codex | 解壓到 `deploy-logs\incoming-日期\`，貼「五」 |
| 別人要安裝 | 對方電腦 | 給他 C 部分的一行指令 |
| 只想看目前狀態，不修改 | 終端機 | `cd C:\agentlab\agent-lab-starter`，`.\repair-windows.ps1 -Diagnose` |

---

## F. 安全界線（ChatGPT 能做與不能做）

完整規則在 `AGENTS.md`，重點是：

- **可以自己做**：安裝、驗收、診斷、自動修復、修正安裝腳本的錯誤（要記錄）、開修正分支與 PR。
- **一定先問你**：重新開機、刪除任何資料或環境、重新產生 `.env`、安裝本套件以外的軟體、調整記憶體上限。
- **絕對不做**：放寬安全控制（護欄、政策、網路隔離、模型代理、Wazuh 規則）、改驗收的通過條件、看或轉述實驗考卷 `app/tests.yaml`、
  顯示密碼與 token、關閉 Defender 或防火牆、改 DGX、直接改 GitHub 正式版。
- **GitHub 的自動檢查**（`.github/workflows/pr-check.yml`）：每個 PR 都會檢查語法；`codex/` 開頭的分支只要碰到允許清單以外的檔案就亮紅叉。

---

## G. 目前的限制

- `get.ps1`、`install-windows.ps1`、`verify-windows.ps1`、`repair-windows.ps1` 已經做過語法檢查與模擬測試（`get.ps1` 的下載、更新時保留資料、git 資料夾不覆蓋、下載失敗不關視窗都測過），
  但**還沒有在實體 Windows 11 主機上跑過**。第一次請你在旁邊看著，每個核准都看一下內容。
- Codex 的 Windows 版有社群回報的狀況：部分版本即使以系統管理員開啟，仍出現 740「需要提升權限」。`AGENTS.md` 已寫了替代做法（跳出 Windows 的「是／否」視窗讓你按）。
- GB10 的 Ollama 沒有帳號密碼，安全靠 B4 的防火牆白名單；這是研究環境的已知殘餘風險，論文或報告裡描述威脅模型時要寫明。
- 一行指令下載的是 GitHub 上 `main` 的最新版。之後若要讓大家固定裝某一版，可以在 GitHub 建立版本標籤（tag），指令加 `-Ref <標籤>`。

## 參考資料

- OpenAI，Windows 桌面程式說明（安裝方式、Add new project、Ask for approval、以系統管理員執行）：<https://learn.chatgpt.com/docs/windows/windows-app>〔已查證，2026-11-12 讀取〕
- OpenAI 社群，The Codex app is now on Windows（2026-03-04；含中文使用者名稱與 `CODEX_HOME` 的回報）：<https://community.openai.com/t/the-codex-app-is-now-on-windows/1375704>〔已查證〕
- Ollama FAQ（對外監聽 `OLLAMA_HOST`、systemd 設定、`OLLAMA_NO_CLOUD`、ollama.com 帳號用途）：<https://raw.githubusercontent.com/ollama/ollama/main/docs/faq.mdx>〔已查證，2026-11-12 讀取〕
- Ollama 模型庫 gemma4：<https://registry.ollama.ai/library/gemma4>〔已查證〕
- GitHub Docs，Adding a file to a repository（網頁上傳上限）：<https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository>〔已查證〕
- OpenAI 社群，Windows Codex app cannot be elevated（2026-06，740 錯誤回報，討論串中未見官方回覆）：<https://community.openai.com/t/windows-codex-app-cannot-be-elevated/1383996>〔已查證〕
