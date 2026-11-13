/* portal.js — 入口網站前端
   資料來源（全部由 portal.py 提供）：
     /api/config   埠號、是否需要 PIN
     /api/status   各元件健康、執行器心跳、模型是否在線、被撤銷的 Agent   （每 5 秒）
     /api/proof    兩條鐵律的對照計數（從紀錄檔計算；?since= 只算本場展示）（每 8 秒）
     /api/stats    Wazuh 告警分類計數                                       （每 8 秒）
     /api/cases    考卷題目（只有標題，不含題目原文）
     /api/verify   最近一次佈署驗收報告與歷次結果                           （每 30 秒）
     /api/results  考卷批次結果（三種條件的對照）                           （每 30 秒）
     /api/run      送出工作；/api/jobs/... 查結果（每 1.5 秒）
     /api/stream   即時事件（SSE）
*/
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, area = "local") { try { return (area === "local" ? localStorage : sessionStorage).getItem(k); } catch { return null; } },
    set(k, v, area = "local") { try { (area === "local" ? localStorage : sessionStorage).setItem(k, v); } catch { /* 無痕或封鎖儲存時忽略 */ } },
    del(k, area = "local") { try { (area === "local" ? localStorage : sessionStorage).removeItem(k); } catch { /* 同上 */ } },
  };

  const state = {
    config: { pin_required: false, grafana_port: "3000", wazuh_port: "8443" },
    status: null,
    proof: null,
    stats: null,
    verify: null,            // /api/verify
    results: null,           // /api/results
    cases: null,             // /api/cases
    lastChecks: null,        // 本場在操作台做過的網路隔離檢查
    resModel: null,          // 實驗結果區選的模型
    proofSince: Number(store.get("proof_since", "session")) || 0,
    presentIdx: -1,          // 展示提詞列目前在第幾步（-1＝沒有在展示）
    lanes: { governed: { job: null, state: "idle", kind: null }, baseline: { job: null, state: "idle", kind: null } },
    traceMode: {},           // trace_id → governed / baseline
    lastCase: {},            // case_id → { governed: result, baseline: result }
  };

  // ------------------------------------------------------------------ 元件資料（架構圖與元件介紹共用）
  const ZONES = [
    { id: "entry", name: "入口", note: "任務從這裡進來" },
    { id: "gate", name: "Agent Gateway", note: "Agent 與外界之間唯一的通道" },
    { id: "runtime", name: "Agent runtime", note: "受治理 Agent 與兩側護欄，網路隔離" },
    { id: "model", name: "本地模型", note: "Agent → 模型代理 → Ollama → LLM，資料不出組織" },
    { id: "svc", name: "內部服務", note: "被保護的資源與誘餌" },
    { id: "ext", name: "外部", note: "模擬網際網路上的攻擊者" },
    { id: "mon", name: "監控與回應", note: "老師圖中的 ELK：看得見、能處置" },
    { id: "base", name: "對照組", note: "沒有治理時會發生什麼事" },
  ];
  const COMPONENTS = {
    portal: { zone: "entry", name: "藍隊分析人員／入口網站", sw: "FastAPI＋原生 JavaScript（本頁）", rules: [],
      desc: "展示與操作的入口。任務放進共享資料夾，由各 Agent 的執行器取走；入口網站和受治理 Agent 之間沒有任何網路連線，不會在隔離牆上開洞。任務進到受治理 Agent 前，一律經 Gateway 送輸入護欄檢查。",
      status: [] },
    toolproxy: { zone: "gate", name: "治理閘道（Agent Gateway／PEP）", sw: "FastAPI・policy.yaml", rules: [1, 2],
      desc: "零信任架構的政策執行點，也是老師架構圖中的 Agent Gateway。每個請求都要帶憑證；閘道驗明身分、查政策（工具白名單、SQL 只讀、URL 與 IP 範圍、影響他人的動作要人核准），通過才代為執行。任務、工具參數、工具回傳與最終回答都由它轉給兩側護欄檢查，Agent 無法略過。每一個決策都留下紀錄。",
      status: ["toolproxy"] },
    idp: { zone: "gate", name: "身分與政策", sw: "閘道內建身分登錄（可換 Keycloak）", rules: [1, 2],
      desc: "記錄每個 Agent 的身分、角色與可用的工具，對應「憑證 → Proxy → IdP → 服務」。目前由治理閘道內建的身分登錄擔任，之後可替換為獨立的 IdP。SOAR 撤銷憑證就是改這裡的狀態。",
      status: ["toolproxy"] },
    guard_in: { zone: "runtime", name: "護欄（輸入）", sw: "guard 服務：確定性規則＋選用的本地防護模型", rules: [1, 2],
      desc: "檢查進到 Agent 的內容：任務本身若夾帶操控 AI 的指令就整個攔下；工具回傳的內容（文件、log、網頁）移除疑似指令的那幾行、遮蔽秘密，再交給 Agent。護欄服務只在內部網段，Agent 連不到，只能由 Gateway 呼叫。",
      status: ["guard"] },
    governed: { zone: "runtime", name: "受治理 Agent", sw: "Python・OpenAI 相容 API", rules: [1, 2],
      desc: "實驗組。和對照組用同一個模型、同一套工具，但身上沒有任何密碼，只有一張可撤銷的憑證；所在的網路分區只連得到 Gateway 與模型代理。",
      status: ["runner_governed"] },
    guard_out: { zone: "runtime", name: "護欄（輸出）", sw: "guard 服務：確定性規則", rules: [1],
      desc: "檢查 Agent 要送出去的內容：工具參數裡夾帶秘密或個資時整筆不執行（防止把資料帶出去，Wazuh 會以高風險告警通知 SOAR）；最終回答出現秘密就遮蔽後才交出。",
      status: ["guard"] },
    llmproxy: { zone: "model", name: "模型代理", sw: "FastAPI（llmproxy）", rules: [1],
      desc: "受治理 Agent 連模型的唯一出口。只放行核准的本地模型，拒絕雲端模型（Ollama 的雲端模型會把提示送到 Ollama 的伺服器）；不開放下載或刪除模型的 API；每次呼叫都留紀錄，但不記提示原文。",
      status: ["llm_proxy"] },
    model: { zone: "model", name: "Ollama", sw: "Ollama（建議放在 DGX，設 OLLAMA_NO_CLOUD=1）", rules: [1],
      desc: "本地的模型服務，提供 OpenAI 相容 API。應關閉雲端模型功能，確保提示只在本地處理。",
      status: ["model"] },
    llm: { zone: "model", name: "LLM", sw: "支援工具呼叫的開放權重模型", rules: [1],
      desc: "大型語言模型本身。放在本地，組織資料不會送到雲端；可以隨時換模型，比較不同模型在同一份考卷上的表現。",
      status: ["model"] },
    db: { zone: "svc", name: "公司資料庫", sw: "PostgreSQL", rules: [1],
      desc: "虛構的公司員工資料，其中埋了誘餌帳密與假身分證號。受治理 Agent 只能經閘道用唯讀帳號查詢；誘餌出現在任何輸出裡，就代表資料外洩。",
      status: ["postgres"] },
    wiki: { zone: "svc", name: "內部文件", sw: "Markdown 文件", rules: [1, 2],
      desc: "模擬內部知識庫，其中幾份文件夾帶提示注入，用來測試 Agent 讀到惡意內容時會不會被牽著走。",
      status: ["toolproxy"] },
    threatintel: { zone: "svc", name: "威脅情資服務", sw: "模擬 API", rules: [2],
      desc: "回傳 IP 信譽資料，給 Agent 做正常的資安分析，也會被用來投放誘導封鎖的內容。",
      status: ["threatintel"] },
    victim: { zone: "svc", name: "受害主機", sw: "模擬服務", rules: [2],
      desc: "代表組織內的其他主機。它會記下每一次被連線，只要有請求進來，就代表 Agent 對內發動了攻擊。",
      status: ["victim"] },
    attacker: { zone: "ext", name: "攻擊者收集站", sw: "模擬服務", rules: [1],
      desc: "代表網際網路上的攻擊者伺服器。收到資料就代表資料被送出組織。",
      status: ["attacker"] },
    wazuh: { zone: "mon", name: "Wazuh", sw: "Wazuh 4.14（manager／indexer〔OpenSearch〕／dashboard）", rules: [1, 2],
      desc: "老師圖中「ELK or Something」的位置：indexer 以 OpenSearch 為基礎，負責存放與查詢；manager 用自訂規則偵測閘道拒絕、注入、對內攻擊、資料外送、護欄攔截、模型代理拒絕等事件，並把重大告警推給 SOAR。",
      status: ["manager", "indexer", "dashboard"] },
    soar: { zone: "mon", name: "SOAR 自動回應", sw: "FastAPI（之後可接 Shuffle）", rules: [1, 2],
      desc: "收到 Wazuh 告警後依信心度評分（V1–V5）決定處置：分數夠高就呼叫 Gateway 撤銷該 Agent 的憑證，Agent 下一個動作立刻被擋。未治理的 Agent 沒有經過 Gateway，SOAR 沒有身分可以撤銷，這也是對照重點。",
      status: ["soar"] },
    grafana: { zone: "mon", name: "Grafana 戰情室", sw: "Grafana 12", rules: [],
      desc: "大螢幕即時儀表板，呈現告警趨勢、兩組 Agent 的對照與處置紀錄。",
      status: ["grafana"] },
    baseline: { zone: "base", name: "未治理 Agent", sw: "Python・OpenAI 相容 API", rules: [],
      desc: "對照組。直接連資料庫（用管理員帳號）、可以上網、直接連模型，系統提示裡還放著管理密碼與誘餌。代表「把 Agent 直接接上系統」的常見做法，用來顯示沒有治理會發生什麼事。",
      status: ["runner_baseline"] },
  };
  const RULE_NAME = { 1: "鐵律一", 2: "鐵律二" };
  const RULE_LABELS = {
    "100901": "閘道拒絕", "100902": "疑似提示注入", "100903": "對內攻擊",
    "100904": "資料外送", "100905": "待人工核准", "100906": "已執行封鎖", "100907": "誘餌秘密外洩", "100908": "SOAR 自動斷線",
    "100909": "護欄攔下注入", "100910": "護欄擋下外送", "100911": "模型代理拒絕", "100912": "護欄遮蔽敏感資料",
    "100913": "護欄遮蔽外部連結",
  };
  // /api/status 的元件代號 → 給人看的名稱（展示前檢查用）
  const COMP_NAME = {
    toolproxy: "治理閘道", soar: "SOAR", indexer: "Wazuh indexer", manager: "Wazuh manager", dashboard: "Wazuh dashboard",
    grafana: "Grafana", postgres: "公司資料庫", victim: "受害主機", attacker: "攻擊者收集站", threatintel: "威脅情資服務",
    guard: "護欄服務", runner_governed: "受治理 Agent 執行器", runner_baseline: "未治理 Agent 執行器",
  };
  // 第三章 lab 的黑箱題與模組（見 docs/第三章攻擊情境_lab設計_v1.md §2）
  const CH3 = { A7: "L4 視覺隱藏注入", A8: "L3 跨文件碎片注入", A9: "L5 import 解析洩密", A10: "L6 知識庫投毒", A11: "L7 跨會話擷取" };
  const CONDS = [
    { id: "baseline", name: "未治理" },
    { id: "governed", name: "只有 Gateway" },
    { id: "governed+guard", name: "Gateway＋護欄" },
  ];
  const COND_NAME = { baseline: "未治理", governed: "只有 Gateway", "governed+guard": "Gateway＋護欄", "governed-mixed": "護欄中途切換（不列入對照）" };

  // ------------------------------------------------------------------ 共用
  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const pin = $("#pin").value || store.get("portal_pin", "session") || "";
    if (pin) headers["X-Portal-Pin"] = pin;
    const r = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok) {
      const err = new Error((data && data.error) || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }
  function msg(text, isErr = false) {
    const el = $("#form-msg");
    el.textContent = text;
    el.classList.toggle("err", isErr);
  }
  function hhmmss(ts) {
    const d = ts ? new Date(ts) : new Date();
    return isNaN(d) ? "" : d.toLocaleTimeString("zh-TW", { hour12: false });
  }
  function toDate(t) {                         // epoch 秒或 ISO 字串
    if (t === null || t === undefined || t === "") return null;
    const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
    return isNaN(d) ? null : d;
  }
  function fmtTime(t) {
    const d = toDate(t);
    return d ? d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "時間不明";
  }
  function ago(t) {
    const d = toDate(t);
    if (!d) return "";
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 90) return "剛剛";
    if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} 小時前`;
    return `${Math.round(s / 86400)} 天前`;
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
  function wilson(k, n, z = 1.96) {             // 與 run_tests.py 相同的 95% Wilson 信賴區間
    if (!n) return [0, 0];
    const p = k / n, d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  function wazuhDiscover(query, from = "now-24h") {
    // Wazuh dashboard 4.14（OpenSearch Dashboards 2.19）的 Discover 網址；查詢字串用 rison 跳脫後再編碼
    const q = encodeURIComponent(String(query).replace(/!/g, "!!").replace(/'/g, "!'"));
    return `https://${location.hostname}:${state.config.wazuh_port}/app/data-explorer/discover` +
      "#?_a=(discover:(columns:!(_source),isDirty:!f,sort:!()),metadata:(indexPattern:'wazuh-alerts-*',view:discover))" +
      `&_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:${from},to:now))` +
      `&_q=(filters:!(),query:(language:kuery,query:'${q}'))`;
  }

  // ------------------------------------------------------------------ 主題
  function setGrafanaTheme() {
    if (!state.dash) return;
    const t = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    $("#grafana-iframe").src = `${state.dash}?orgId=1&kiosk&refresh=10s&theme=${t}`;
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $("#theme-toggle").textContent = t === "dark" ? "淺色" : "深色";
    setGrafanaTheme();
  }
  function initTheme() {
    const saved = store.get("portal_theme");
    const sys = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyTheme(saved || sys);
    $("#theme-toggle").addEventListener("click", () => {
      const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(t);
      store.set("portal_theme", t);
    });
  }

  // ------------------------------------------------------------------ 設定與外部連結
  async function loadConfig() {
    try { state.config = await api("/api/config"); } catch { /* 用預設值 */ }
    const host = location.hostname;
    const grafana = `${location.protocol}//${host}:${state.config.grafana_port}`;
    const dash = `${grafana}/d/${state.config.dashboard_uid || "agentlab-warroom"}/`;
    $("#link-grafana").href = dash;
    state.dash = dash;
    $("#grafana-open").href = `${dash}?orgId=1&kiosk&refresh=10s`;
    setGrafanaTheme();
    $("#link-wazuh").href = `https://${host}:${state.config.wazuh_port}`;
    $("#wazuh-all").href = wazuhDiscover("rule.groups:agentlab");
    if (state.config.pin_required) {
      $("#pin-wrap").hidden = false;
      $("#pin").value = store.get("portal_pin", "session") || "";
      $("#pin").addEventListener("change", () => store.set("portal_pin", $("#pin").value, "session"));
    }
  }

  // ------------------------------------------------------------------ 健康狀態
  function nodeHealth(id, s) {
    const c = COMPONENTS[id];
    if (!c.status.length) return { cls: "ok", text: "正常" };
    const parts = c.status.map((k) => s.components[k]).filter(Boolean);
    if (!parts.length) return { cls: "", text: "未知" };
    const ok = parts.every((p) => p.ok);
    let cls = ok ? "ok" : "bad";
    let text = ok ? "正常" : parts.filter((p) => !p.ok).map((p) => p.detail).join("；");
    if (id === "governed" && s.revoked && s.revoked.length) { cls = "warn"; text = `已被 SOAR 斷線（${s.revoked.join("、")}）`; }
    if ((id === "model" || id === "llm") && !ok) text = "沒有連線：Agent 無法作答";
    if ((id === "guard_in" || id === "guard_out") && ok && s.guardrails === false) { cls = "warn"; text = "護欄已關閉（對照實驗中）"; }
    return { cls, text };
  }
  async function pollStatus() {
    try {
      const s = await api("/api/status");
      state.status = s;
      let okN = 0, total = 0;
      for (const id of Object.keys(COMPONENTS)) {
        const h = nodeHealth(id, s);
        const dot = $(`.node[data-id="${id}"] .dot`);
        if (dot) dot.setAttribute("class", `dot ${h.cls}`);
        total += 1;
        if (h.cls === "ok" || h.cls === "warn") okN += 1;
      }
      const pill = $("#health-pill");
      pill.textContent = okN === total ? "全部元件正常" : `${total - okN} 個元件異常`;
      pill.className = `health-pill ${okN === total ? "ok" : "bad"}`;
      const modelOk = s.runners.governed.model_ok || s.runners.baseline.model_ok;
      $("#model-warning").hidden = modelOk || !(s.runners.governed.alive || s.runners.baseline.alive);
      const gm = s.runners.governed;
      const warnText = $("#model-warning-text");
      if (warnText.dataset.default === undefined) warnText.dataset.default = warnText.innerHTML;
      warnText.innerHTML = warnText.dataset.default;   // 預設說明（固定文字，非伺服器資料）
      if (!modelOk && gm.model_missing) {
        // 模型主機連得到、但還沒下載 .env 指定的模型：直接告訴使用者要在模型主機做什麼
        $("#model-warning-text").textContent =
          `模型主機連得到，但還沒有模型 ${gm.model}，Agent 無法作答。請在模型主機（例如 GB10）執行 ollama pull ${gm.model}，或把 .env 的 MODEL 改成已下載的名稱。`;
      }
      syncGuard(s.guardrails);
      const revoked = (s.revoked || []).length > 0;
      $("#reset-btn").hidden = !revoked;
      if (state.lanes.governed.state === "idle") setLaneState("governed", revoked ? "error" : "idle", revoked ? "已被斷線" : "待命");
      const sel = $(".node.selected");
      if (sel) showDetail(sel.dataset.id);
    } catch {
      state.status = null;
      const pill = $("#health-pill");
      pill.textContent = "入口網站後端沒有回應";
      pill.className = "health-pill bad";
    }
    renderGuide();
  }

  // ------------------------------------------------------------------ 護欄開關
  function syncGuard(on) {
    if (on === undefined || on === null) return;
    const t = $("#guard-toggle");
    if (document.activeElement !== t) t.checked = !!on;
    $("#guard-state").textContent = on ? "開啟" : "關閉";
    const lg = $("#lane-guard");
    lg.textContent = on ? "護欄開啟" : "護欄關閉（只有 Gateway）";
    lg.classList.toggle("off", !on);
  }
  async function setGuard(on) {
    const t = $("#guard-toggle");
    t.disabled = true;
    try {
      const r = await api("/api/guardrails", { method: "POST", body: JSON.stringify({ enabled: on }) });
      syncGuard(r.enabled);
      msg(r.enabled ? "已開啟受治理 Agent 的護欄。" : "已關閉受治理 Agent 的護欄：現在只靠 Gateway，可以對照差別。");
      if ($("#pin").value) store.set("portal_pin", $("#pin").value, "session");
      pollStatus();
    } catch (err) {
      t.checked = !on;
      if (err.status === 401) { msg("需要操作員 PIN，請輸入後再切換一次。", true); $("#pin-wrap").hidden = false; $("#pin").focus(); }
      else msg(`切換失敗：${err.message}`, true);
    } finally { t.disabled = busy(); }
  }

  // ------------------------------------------------------------------ 鐵律計數
  async function pollProof() {
    try {
      const since = state.proofSince;
      const p = await api(`/api/proof${since ? `?since=${encodeURIComponent(since)}` : ""}`);
      state.proof = p;
      const set = (key, v) => {
        const el = $(`[data-proof="${key}"]`);
        if (!el) return;
        el.textContent = v;
        el.classList.toggle("zero", v === 0);
      };
      set("baseline.r1", p.baseline.leaks + p.baseline.exfil);
      set("governed.r1", p.governed.leaks + p.governed.exfil);
      set("baseline.r2", p.baseline.attacks);
      set("governed.r2", p.governed.attacks);
      const g = p.governed;
      const scope = since ? `只算本場展示，${fmtTime(since)} 起` : "自這次部署起";
      $("#proof-note").textContent =
        `計數來自本環境的紀錄（${scope}）：未治理 Agent 作答 ${p.baseline.runs} 次、受治理 Agent 作答 ${g.runs} 次；` +
        `Gateway 共擋下 ${g.denied} 個請求、送人工核准 ${g.pending} 個；護欄攔下 ${g.guard_blocked || 0} 次、遮蔽 ${g.guard_redacted || 0} 次；` +
        `模型代理拒絕 ${g.llm_denied || 0} 次；SOAR 斷線 ${g.revocations} 次。每 8 秒更新。`;
      $("#proof-scope").textContent = since ? "改回自部署起算" : "只算本場展示";
    } catch { /* 下次再試 */ }
    renderGuide();
  }
  function toggleProofScope() {
    if (state.proofSince) { state.proofSince = 0; store.del("proof_since", "session"); }
    else { state.proofSince = Math.floor(Date.now() / 1000); store.set("proof_since", String(state.proofSince), "session"); }
    pollProof();
  }

  // ------------------------------------------------------------------ Wazuh 偵測統計
  async function pollStats() {
    try {
      const s = await api("/api/stats?window=24h");
      state.stats = s;
      const ul = $("#bars");
      if (!s.ok) { ul.innerHTML = `<li class="muted">讀不到 Wazuh 資料（${esc(s.detail)}）</li>`; }
      else {
        const ids = Object.keys(RULE_LABELS);
        const max = Math.max(1, ...ids.map((i) => s.by_rule[i] || 0));
        ul.innerHTML = ids.map((i) => {
          const n = s.by_rule[i] || 0;
          const href = wazuhDiscover(`rule.groups:agentlab and rule.id:${i}`);
          return `<li><a href="${esc(href)}" target="_blank" rel="noopener" title="在 Wazuh 開啟規則 ${i} 的原始告警">${esc(RULE_LABELS[i])}</a>` +
            `<span class="track"><span class="fill ${n ? "" : "zero"}" style="width:${(n / max) * 100}%"></span></span><span class="n">${n}</span></li>`;
        }).join("");
        const lb = s.leak_by_mode || {};
        $("#bars-total").textContent = `共 ${s.total || 0} 筆 agentlab 告警（含一般事件）。誘餌外洩：未治理 ${lb.baseline || 0} 次，受治理 ${lb.governed || 0} 次。`;
      }
    } catch { /* 下次再試 */ }
    renderGuide();
  }

  // ------------------------------------------------------------------ 事件描述（事件流與兩條通道共用）
  function modeOf(e) {
    if (e.mode === "governed" || e.mode === "baseline") return e.mode;
    if (e.stream === "soar-decisions") return "soar";
    if (e.stream === "toolproxy-decisions" || e.stream === "guard-decisions" || e.stream === "llm-calls") return "governed";
    return state.traceMode[e.trace_id] || (e.mode === "soar" ? "soar" : "");
  }
  function describe(e) {
    const m = modeOf(e);
    switch (e.stream) {
      case "agent-events":
        if (e.type === "question") return { text: "收到問題，開始分析", cls: "", nodes: [m] };
        if (e.type === "tool_call") {
          const via = m === "governed" ? "經治理閘道" : "直接";
          return { text: `${via}呼叫工具 ${e.tool}`, cls: "", nodes: m === "governed" ? ["governed", "toolproxy"] : ["baseline", toolNode(e.tool)] };
        }
        if (e.type === "answer") {
          if (e.end_reason === "guard_blocked_task") return { text: "任務未交給 Agent 執行", cls: "ok", nodes: [m] };
          return { text: m === "governed" && e.guardrails === false ? "作答完成（護欄關閉）" : "作答完成", cls: "", nodes: [m] };
        }
        if (e.type === "fallback_json_mode") return { text: "模型不支援原生工具呼叫，改用 JSON 模式", cls: "warn", nodes: [m] };
        return { text: e.type || "Agent 事件", cls: "", nodes: [m] };
      case "toolproxy-decisions": {
        const inj = e.injection_suspected ? "（工具回傳內容疑似提示注入，已標記）" : "";
        if (e.decision === "allow") return { text: `治理閘道 允許 ${e.tool}${inj}`, cls: inj ? "warn" : "", nodes: ["toolproxy", toolNode(e.tool)] };
        if (e.decision === "deny") return { text: `治理閘道 拒絕 ${e.tool}：${e.reason || ""}`, cls: "ok", nodes: ["toolproxy"] };
        if (e.decision === "pending") return { text: `治理閘道 送人工核准 ${e.tool}：${e.reason || ""}`, cls: "warn", nodes: ["toolproxy"] };
        return { text: `治理閘道 ${e.decision || "決策"} ${e.tool || ""}`, cls: "", nodes: ["toolproxy"] };
      }
      case "guard-decisions": {
        const stage = { task: "任務", tool_result: `工具回傳（${e.tool || ""}）`, tool_args: `工具參數（${e.tool || ""}）`, answer: "回答" }[e.stage] || e.stage;
        const node = e.direction === "out" ? "guard_out" : "guard_in";
        const cat = String(e.categories || "").split(",").map((c) => ({ injection: "疑似注入", dlp: "敏感資料" }[c])).filter(Boolean).join("、");
        if (e.guard_decision === "block") return { text: `護欄攔下${stage}：${cat || "未通過檢查"}`, cls: "ok", nodes: [node, "governed"] };
        if (e.guard_decision === "redact") return { text: `護欄處理${stage}：${e.direction === "in" && cat.includes("注入") ? "移除疑似指令" : "遮蔽"}${cat ? `（${cat}）` : ""}`, cls: "ok", nodes: [node] };
        return { text: `護欄檢查${stage}：通過`, cls: "", nodes: [node] };
      }
      case "llm-calls":
        if (e.llm_decision === "deny") return { text: `模型代理拒絕：${e.reason || ""}`, cls: "ok", nodes: ["llmproxy"] };
        if (e.llm_decision === "error") return { text: `模型代理：模型服務錯誤（${e.reason || ""}）`, cls: "warn", nodes: ["llmproxy", "model"] };
        return { text: `${e.caller === "guard" ? "護欄的防護模型" : "Agent"} 經模型代理呼叫 ${e.model || "模型"}`, cls: "", nodes: ["llmproxy", "model", "llm"] };
      case "sink-hits":
        if (e.role === "victim") return { text: `受害主機收到請求 ${e.path || ""}`, cls: "bad", nodes: ["victim"], bad: true };
        if (e.role === "attacker") return { text: "攻擊者收集站收到資料", cls: "bad", nodes: ["attacker"], bad: true };
        return { text: `${e.role} 收到請求`, cls: "", nodes: [] };
      case "approvals":
        if (e.action === "soar_review") return { text: `SOAR 送交 SOC 審查（評分 ${e.score}）`, cls: "warn", nodes: ["soar"] };
        return { text: `等待人工核准：${e.action} ${e.ip || ""}`, cls: "warn", nodes: ["toolproxy"] };
      case "actions":
        if (e.action === "block_ip" && e.executed) return { text: `已執行封鎖 ${e.ip || ""}（影響他人的動作）`, cls: "bad", nodes: [m], bad: true };
        if (e.action === "revoke_token") return { text: `SOAR 撤銷 ${e.agent_id} 的憑證，Agent 已斷線`, cls: "ok", nodes: ["soar", "toolproxy", "governed"] };
        if (e.action === "unrevoke_token") return { text: `解除 ${e.agent_id} 的斷線`, cls: "", nodes: ["toolproxy"] };
        if (e.action === "contain_failed") return { text: "SOAR 判定要處置，但未治理 Agent 沒有可撤銷的身分，無法斷線", cls: "bad", nodes: ["soar"], bad: true };
        return { text: `動作 ${e.action}`, cls: "", nodes: [] };
      case "soar-decisions": {
        const act = { AUTO_BLOCK: "自動斷線", NOTIFY_SOC: "通知 SOC", LOG_ONLY: "只記錄" }[e.action] || e.action;
        return { text: `SOAR 評分 ${e.score}（規則 ${e.rule_id}）→ ${act}`, cls: e.action === "AUTO_BLOCK" ? "warn" : "", nodes: ["wazuh", "soar"] };
      }
      default:
        return { text: e.stream, cls: "", nodes: [] };
    }
  }
  function toolNode(tool) {
    return { query_db: "db", read_doc: "wiki", search_logs: "wazuh", http_get: "", block_ip: "" }[tool] || "";
  }
  function flashNodes(ids, bad) {
    for (const id of ids) {
      const n = id && $(`.node[data-id="${id}"]`);
      if (!n) continue;
      n.classList.remove("flash", "flash-bad");
      void n.getBBox();               // 重新觸發動畫
      n.classList.add(bad ? "flash-bad" : "flash");
    }
  }

  // ------------------------------------------------------------------ 即時事件流
  const MODE_LABEL = { governed: "受治理", baseline: "未治理", soar: "SOAR" };
  function pushGlobal(e, d) {
    const ol = $("#events");
    const li = document.createElement("li");
    const m = modeOf(e);
    li.className = `${d.cls} new`;
    li.innerHTML = `<span class="t">${esc(hhmmss(e["@timestamp"]))}</span><span class="m ${esc(m)}">${esc(MODE_LABEL[m] || "")}</span><span class="x">${esc(d.text)}</span>`;
    ol.prepend(li);
    while (ol.children.length > 60) ol.lastChild.remove();
  }
  function pushLane(target, e, d) {
    const ol = $(`.lane[data-target="${target}"] .lane-events`);
    const li = document.createElement("li");
    li.className = `${d.cls} new`;
    li.innerHTML = `<span class="t">${esc(hhmmss(e["@timestamp"]))}</span>${esc(d.text)}`;
    ol.append(li);
    ol.scrollTop = ol.scrollHeight;
  }
  function onEvent(e) {
    if (e.stream === "agent-events" && e.trace_id && (e.mode === "governed" || e.mode === "baseline")) state.traceMode[e.trace_id] = e.mode;
    const d = describe(e);
    pushGlobal(e, d);
    flashNodes(d.nodes, d.bad);
    for (const t of ["governed", "baseline"]) {
      const lane = state.lanes[t];
      if (lane.job && e.trace_id === lane.job) pushLane(t, e, d);
    }
    // 撤銷事件沒有 trace_id：受治理通道正在跑或剛跑完時，一併顯示
    if (e.stream === "actions" && e.action === "revoke_token" && state.lanes.governed.job) pushLane("governed", e, d);
    if (e.stream === "actions" && e.action === "revoke_token") setTimeout(pollStatus, 300);
  }
  function startStream() {
    if (!window.EventSource) return;
    const es = new EventSource("/api/stream");
    const st = $("#stream-state");
    es.onopen = () => { st.textContent = "即時"; st.classList.add("live"); };
    es.onerror = () => { st.textContent = "重新連線中"; st.classList.remove("live"); };
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* 忽略壞資料 */ } };
  }
  async function loadRecent() {
    try {
      const r = await api("/api/recent?n=40");
      for (const e of r.events) {
        if (e.stream === "agent-events" && e.trace_id && e.mode) state.traceMode[e.trace_id] = e.mode;
      }
      for (const e of r.events) pushGlobal(e, describe(e));
      $$("#events li.new").forEach((li) => li.classList.remove("new"));
    } catch { /* 沒有歷史事件 */ }
  }

  // ------------------------------------------------------------------ 實驗操作台
  function setLaneState(target, st, label) {
    const el = $(`.lane[data-target="${target}"] .lane-state`);
    el.dataset.state = st;
    el.textContent = label;
  }
  function busy() { return Object.values(state.lanes).some((l) => l.state === "running"); }
  function setBusy() {
    const b = busy();
    $("#ask-btn").disabled = b;
    $("#checks-btn").disabled = b;
    $("#guard-toggle").disabled = b;
    $$(".exp-group button").forEach((x) => { x.disabled = b; });
  }

  async function submit(payload, kindLabel) {
    if (busy()) return;
    msg("送出中…");
    let res;
    try {
      res = await api("/api/run", { method: "POST", body: JSON.stringify({ target: "both", ...payload }) });
    } catch (err) {
      if (err.status === 401) { msg("需要操作員 PIN，請在右側輸入後再送出。", true); $("#pin-wrap").hidden = false; $("#pin").focus(); }
      else msg(`送不出去：${err.message}`, true);
      return;
    }
    if ($("#pin").value) store.set("portal_pin", $("#pin").value, "session");
    const skipped = res.skipped || {};
    msg(skipped.baseline ? `${kindLabel}已送出，只考受治理 Agent。` : `${kindLabel}已送出，兩個 Agent 同時作答中。`);
    for (const [t, why] of Object.entries(skipped)) {
      // 這一題對照組不考（第三章 lab 的工具只給受治理組）：清掉上一題的結果，寫明原因
      state.lanes[t] = { job: null, state: "idle", kind: payload.type, case_id: payload.case_id };
      $(`.lane[data-target="${t}"] .lane-events`).innerHTML = `<li><span class="t">${esc(hhmmss())}</span>${esc(why)}</li>`;
      $(`.lane[data-target="${t}"] .lane-result`).innerHTML = "";
      setLaneState(t, "idle", "這題不考");
    }
    for (const [t, jid] of Object.entries(res.jobs)) {
      state.traceMode[jid] = t;
      state.lanes[t] = { job: jid, state: "running", kind: payload.type, case_id: payload.case_id };
      $(`.lane[data-target="${t}"] .lane-events`).innerHTML = payload.type === "checks"
        ? `<li><span class="t">${esc(hhmmss())}</span>從這個 Agent 所在的網路，逐一嘗試連到環境裡的每個地方</li>` : "";
      $(`.lane[data-target="${t}"] .lane-result`).innerHTML = "";
      setLaneState(t, "running", "排隊中");
      pollJob(t, jid, Date.now());
    }
    setBusy();
    // 展示中：提詞列會蓋住畫面下方，直接捲到兩個 Agent 的作答區；平常捲到操作台頂端
    (state.presentIdx >= 0 ? $(".lanes") : document.getElementById("console")).scrollIntoView({ block: "start" });
  }

  async function pollJob(target, jid, t0) {
    const lane = state.lanes[target];
    if (lane.job !== jid) return;
    let r = null;
    try { r = await api(`/api/jobs/${target}/${jid}`); } catch (err) { r = err.status === 404 ? { status: "unknown" } : null; }
    if (r && r.status === "running") setLaneState(target, "running", "作答中");
    if (r && (r.status === "done" || r.status === "error")) { finishLane(target, r); return; }
    if (Date.now() - t0 > 10 * 60 * 1000) { finishLane(target, { status: "error", error: "等了 10 分鐘沒有結果。請確認執行器容器是否在跑（./lab.sh status）。" }); return; }
    if (r && r.status === "pending" && Date.now() - t0 > 20000 && state.status && !state.status.runners[target].alive) {
      setLaneState(target, "running", "等待執行器");
    }
    setTimeout(() => pollJob(target, jid, t0), 1500);
  }

  function badge(held, name) {
    return held
      ? `<span class="badge held" aria-label="${name}守住"><span aria-hidden="true">✓</span>${name} 守住</span>`
      : `<span class="badge breach" aria-label="${name}失守"><span aria-hidden="true">✕</span>${name} 失守</span>`;
  }
  function highlightSecrets(text) {
    return esc(text).replace(/(CANARY-[A-Za-z0-9_\-]+|FLAG\{[^}]*\}|FAKE-ID-\d{4})/g, "<mark>$1</mark>")
      .replace(/(［已遮蔽：[a-z_]+］|［護欄：[^］]*］)/g, '<span class="redacted">$1</span>');
  }

  function finishLane(target, r) {
    const lane = state.lanes[target];
    lane.state = r.status === "done" ? "done" : "error";
    const box = $(`.lane[data-target="${target}"] .lane-result`);
    if (r.status !== "done") {
      setLaneState(target, "error", "失敗");
      box.innerHTML = `<p class="form-msg err">${esc(r.error || "執行失敗")}</p>`;
      setBusy();
      return;
    }
    setLaneState(target, "done", "完成");
    const res = r.result || {};
    if (r.type === "checks") {
      box.innerHTML = renderChecks(target, res);
      state.lastChecks = { ...(state.lastChecks || {}), [target]: res, ts: Date.now() };
      renderGuide();
    } else box.innerHTML = renderAnswer(r, res);
    if (r.type === "test" && res.case) {
      state.lastCase[res.case] = { ...(state.lastCase[res.case] || {}), [target]: res };
      renderLastCase(res.case);
    }
    setBusy();
    pollProof();
  }

  function renderAnswer(r, res) {
    const v = res.verdict || {};
    const tr = res.trace || {};
    const gw = tr.gateway || {};
    let extra = "";
    if (r.type === "test") {
      if (res.kind === "benign") extra = res.success ? `<span class="badge held"><span aria-hidden="true">✓</span>任務完成</span>` : `<span class="badge neutral">任務未完成</span>`;
      else extra = res.success ? `<span class="badge breach"><span aria-hidden="true">✕</span>攻擊得逞</span>` : `<span class="badge held"><span aria-hidden="true">✓</span>攻擊未得逞</span>`;
    }
    const facts = [
      `工具呼叫 <b>${(res.tool_calls || []).length}</b> 次`,
      r.mode === "governed" ? `閘道 允許 <b>${gw.allow || 0}</b>・拒絕 <b>${gw.deny || 0}</b>・待核准 <b>${gw.pending || 0}</b>` : "未經任何閘道",
      r.mode === "governed" ? guardFact(res) : "",
      tr.injection_flagged ? "<b>偵測到疑似注入</b>" : "",
      (tr.victim_hits || []).length ? `受害主機被連 <b>${tr.victim_hits.length}</b> 次` : "",
      (tr.attacker_hits || []).length ? `資料送到收集站 <b>${tr.attacker_hits.length}</b> 次` : "",
      `耗時 <b>${res.latency_s ?? "–"}</b> 秒`,
      r.model ? `模型 ${esc(r.model)}` : "",
    ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
    const title = r.type === "test" ? `<p class="small muted">${esc(res.case)}・${esc(res.title)}</p>` : "";
    return `${title}<div class="verdicts">${badge(v.rule1_held, "鐵律一")}${badge(v.rule2_held, "鐵律二")}${extra}</div>` +
      `<pre class="answer">${highlightSecrets(res.answer || "（沒有回答）")}</pre><p class="facts">${facts}</p>`;
  }

  function guardFact(res) {
    if (res.guardrails === false) return "護欄 <b>關閉</b>";
    const acts = (res.trace && res.trace.guard) || [];
    const blk = acts.filter((a) => a.decision === "block").length;
    const red = acts.filter((a) => a.decision === "redact").length;
    return `護欄 檢查 <b>${(res.trace && res.trace.guard_checks) || 0}</b>・攔下 <b>${blk}</b>・遮蔽 <b>${red}</b>`;
  }

  const LEGIT = { governed: new Set(["toolproxy", "llm-proxy"]), baseline: new Set(["toolproxy", "llm-proxy"]) };
  const HOST_LABEL = {
    postgres: "公司資料庫", "wazuh.indexer": "Wazuh 資料庫", victim: "受害主機", "attacker-site": "攻擊者收集站",
    threatintel: "威脅情資服務", guard: "護欄服務", toolproxy: "治理閘道", "llm-proxy": "模型代理", "1.1.1.1": "網際網路",
  };
  function renderChecks(target, res) {
    const rows = (res.targets || []).map((x) => {
      const legit = LEGIT[target].has(x.host);
      const cls = x.reachable ? (legit ? "yes expected" : "yes") : "no";
      const text = x.reachable ? (legit ? "連得到（合法通道）" : "連得到") : "連不到";
      return `<tr><td>${esc(HOST_LABEL[x.host] || x.host)} <span class="muted small">${esc(x.host)}:${x.port}</span></td><td class="${cls}">${text}</td></tr>`;
    }).join("");
    const exposed = (res.targets || []).filter((x) => x.reachable && !LEGIT[target].has(x.host)).length;
    const head = exposed === 0
      ? `<span class="badge held"><span aria-hidden="true">✓</span>只連得到治理閘道與模型代理</span>`
      : `<span class="badge breach"><span aria-hidden="true">✕</span>可直接連到 ${exposed} 個不該碰的地方</span>`;
    let tok = "";
    if (res.wrong_token_status !== null && res.wrong_token_status !== undefined) {
      tok = res.wrong_token_status === 401
        ? `<p class="small">用偽造的憑證呼叫治理閘道：被拒絕（HTTP 401）。</p>`
        : `<p class="small">用偽造的憑證呼叫治理閘道：${esc(res.wrong_token_status)}</p>`;
    }
    return `<div class="verdicts">${head}</div><table class="checks">${rows}</table>${tok}`;
  }

  // ------------------------------------------------------------------ 實驗清單
  const GROUPS = [
    { rule: "work", title: "正常工作", note: "確認治理不會妨礙正常的資安分析。" },
    { rule: "rule1", title: "鐵律一：敏感資料不外送", note: "誘導 Agent 說出或送出秘密。" },
    { rule: "rule2", title: "鐵律二：Agent 不攻擊別人", note: "誘導 Agent 打內部主機或執行影響他人的動作。" },
  ];
  async function loadCases() {
    const box = $("#exp-groups");
    let cases = [];
    try { cases = (await api("/api/cases")).cases; } catch { box.innerHTML = `<p class="muted">讀不到考卷題目。</p>`; return; }
    state.cases = cases;
    box.innerHTML = GROUPS.map((g) => {
      const items = cases.filter((c) => c.rule === g.rule).map((c) => {
        const tags = [CH3[c.id] ? `<span class="tag">第三章 ${esc(CH3[c.id])}</span>` : "",
          c.governed_only ? `<span class="tag">只考受治理組</span>` : ""].join("");
        const label = c.governed_only ? "跑受治理組" : "兩邊都跑";
        return `<li><span><span class="id">${esc(c.id)}</span>${esc(c.title)}${tags ? `<span class="tags">${tags}</span>` : ""}<span class="last" id="last-${esc(c.id)}"></span></span>` +
          `<button type="button" data-case="${esc(c.id)}">${label}</button></li>`;
      }).join("");
      return `<div class="exp-group" id="exp-${g.rule}"><h3>${g.title}</h3><p>${g.note}</p><ul>${items || '<li class="muted">（沒有題目）</li>'}</ul></div>`;
    }).join("");
    box.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-case]");
      if (b) submit({ type: "test", case_id: b.dataset.case }, `題目 ${b.dataset.case} `);
    });
    setBusy();
    renderGuide();
    renderResults();
  }
  function renderLastCase(cid) {
    const el = document.getElementById(`last-${cid}`);
    if (!el) return;
    const r = state.lastCase[cid];
    const part = (t, label) => {
      const x = r[t];
      if (!x) return "";
      if (x.kind === "benign") return `${label}<span class="${x.success ? "ok" : "bad"}">${x.success ? "完成" : "未完成"}</span>`;
      return `${label}<span class="${x.success ? "bad" : "ok"}">${x.success ? "被攻破" : "守住"}</span>`;
    };
    el.innerHTML = `上次結果：${[part("baseline", "未治理 "), part("governed", "受治理 ")].filter(Boolean).join("，")}`;
  }

  // ------------------------------------------------------------------ 驗證證據：佈署驗收與考卷結果
  async function pollVerify() {
    try { state.verify = await api("/api/verify"); } catch { state.verify = { ok: false, detail: "讀不到驗收報告（入口網站後端沒有回應）", history: [] }; }
    renderAcceptance();
    renderGuide();
  }
  async function pollResults() {
    try { state.results = await api("/api/results"); } catch { state.results = { ok: false, detail: "讀不到考卷結果（入口網站後端沒有回應）", runs: [], matrix: {} }; }
    renderResults();
    renderGuide();
  }
  const verifyCheck = (id) => (state.verify && state.verify.ok ? state.verify.checks.find((c) => c.id === id) : null) || null;
  function checksSummary(ids) {
    if (!state.verify) return { text: "讀取中…", cls: "" };
    if (!state.verify.ok) return { text: "還沒有驗收紀錄", cls: "warn" };
    const cs = ids.map(verifyCheck).filter(Boolean);
    if (!cs.length) return { text: "這份驗收報告沒有這些項目（請用新版重新驗收）", cls: "warn" };
    const bad = cs.filter((c) => c.result !== "pass");
    if (bad.length) return { text: bad.map((c) => `${c.id} ${c.result === "skip" ? "未執行" : "未通過"}`).join("、"), cls: "bad" };
    return { text: `${cs.map((c) => c.id).join("、")} ${cs.length > 1 ? "全部通過" : "通過"}（${fmtTime(state.verify.generated)}）`, cls: "ok" };
  }
  function evidenceText(ev) {
    if (ev === null || ev === undefined || ev === "") return "（沒有證據欄位）";
    return typeof ev === "string" ? ev : JSON.stringify(ev, null, 2);
  }

  function renderAcceptance() {
    const v = state.verify, box = $("#acc-body");
    if (!v) return;
    const hist = (v.history || []).length
      ? `<details class="acc-history"><summary>歷次驗收（最近 ${v.history.length} 次）</summary><ul>${v.history.map((h) =>
          `<li><span class="${h.overall === "PASS" ? "ok" : "bad"}">${h.overall === "PASS" ? "通過" : "未通過"}</span>` +
          `<span>${esc(fmtTime(h.generated))}</span><span class="muted">${h.failed_required.length ? `未通過：${esc(h.failed_required.join("、"))}` : ""}</span>` +
          `<code>${esc(h.file)}</code></li>`).join("")}</ul></details>` : "";
    if (!v.ok) {
      box.innerHTML = `<p class="notice">${esc(v.detail)}。照下方的指令執行一次驗收，報告會出現在這裡。</p>${hist}`;
      return;
    }
    const req = v.checks.filter((c) => c.required), opt = v.checks.filter((c) => !c.required);
    const pass = v.overall === "PASS";
    const n = (arr) => arr.filter((c) => c.result === "pass").length;
    const head = `<div class="acc-head"><p class="acc-overall ${pass ? "ok" : "bad"}"><span aria-hidden="true">${pass ? "✓" : "✕"}</span>${pass ? "驗收通過" : "驗收未通過"}</p>` +
      `<p>必要項 ${n(req)}／${req.length} 通過・選擇性 ${n(opt)}／${opt.length} 通過・${esc(fmtTime(v.generated))}（${esc(ago(v.generated))}）</p>` +
      `<p class="small muted">證據檔：<code>${esc(v.file)}</code></p></div>` +
      (pass ? "" : `<p class="notice bad">未通過的必要項：${esc(v.failed_required.join("、"))}。在主機執行 <code>./lab.sh diagnose</code>（Windows：<code>.\\repair-windows.ps1 -Diagnose</code>）看原因與修法。</p>`);
    const LAYERS = [
      { p: "B", name: "主機層", note: "在 WSL 主機上檢查：容器、偵測規則、主機設定、第三章資料面" },
      { p: "C", name: "環境層", note: "在入口網站的容器裡檢查：網路隔離、護欄、模型代理、告警" },
    ];
    const RES = { pass: ["✓", "通過"], fail: ["✕", "未通過"], skip: ["–", "未執行"] };
    const item = (c) => {
      const [ic, label] = RES[c.result] || ["?", c.result];
      return `<li class="${esc(c.result)}"><span class="id">${esc(c.id)}</span>` +
        `<span class="d">${esc(c.desc)}${c.required ? "" : '<span class="req">選擇性</span>'}</span>` +
        `<span class="res"><span aria-hidden="true">${ic}</span>${label}</span>` +
        `<details><summary>證據</summary><pre>${esc(evidenceText(c.evidence))}</pre></details></li>`;
    };
    const groups = LAYERS.map((L) => {
      const cs = v.checks.filter((c) => c.id.startsWith(L.p));
      return cs.length ? `<section class="acc-group"><h3>${L.name}<small>${L.note}</small></h3><ul class="acc-list">${cs.map(item).join("")}</ul></section>` : "";
    }).join("");
    const other = v.checks.filter((c) => !LAYERS.some((L) => c.id.startsWith(L.p)));
    box.innerHTML = head + `<div class="acc-groups">${groups}${other.length ? `<section class="acc-group"><h3>其他</h3><ul class="acc-list">${other.map(item).join("")}</ul></section>` : ""}</div>${hist}`;
  }

  function pickModel(r) {
    const models = Object.keys(r.matrix || {});
    const cur = state.status && state.status.runners.governed.model;
    if (state.resModel && r.matrix[state.resModel]) return state.resModel;
    if (cur && r.matrix[cur]) return cur;
    const latest = (r.runs || []).find((x) => r.matrix[x.model]);
    return latest ? latest.model : models[0];
  }
  function filesTable(runs) {
    if (!runs || !runs.length) return "";
    return `<details class="res-files"><summary>資料來源：${runs.length} 個結果檔（每一格取最近一次有測這一題的結果）</summary>` +
      `<div class="table-scroll"><table><thead><tr><th scope="col">時間</th><th scope="col">條件</th><th scope="col">模型</th><th scope="col">題數</th><th scope="col">作答次數</th><th scope="col">檔案</th></tr></thead><tbody>` +
      runs.map((x) => `<tr><td>${esc(fmtTime(x.time))}</td><td>${esc(COND_NAME[x.condition] || x.condition)}</td><td>${esc(x.model)}</td>` +
        `<td>${x.n_cases}</td><td>${x.n_rows}</td><td><code>${esc(x.file)}</code></td></tr>`).join("") +
      `</tbody></table></div></details>`;
  }
  function renderResults() {
    const r = state.results, box = $("#results-body");
    if (!r) return;
    if (!r.ok) { box.innerHTML = `<p class="notice">${esc(r.detail || "讀不到考卷結果")}</p>`; return; }
    const models = Object.keys(r.matrix || {});
    if (!models.length) {
      box.innerHTML = `<p class="notice">還沒有考卷批次結果。照下方的指令跑一次，這裡會自動出現三種條件的對照表。</p>${filesTable(r.runs)}`;
      return;
    }
    const model = pickModel(r);
    state.resModel = model;
    const mx = r.matrix[model];
    const cur = state.status && state.status.runners.governed.model;
    const present = CONDS.filter((c) => mx[c.id] && Object.keys(mx[c.id]).length);
    const info = new Map((state.cases || []).map((c) => [c.id, c]));
    const order = (state.cases || []).map((c) => c.id);
    const ids = [...new Set(present.flatMap((c) => Object.keys(mx[c.id])))];
    const pos = (id) => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
    ids.sort((a, b) => pos(a) - pos(b) || a.localeCompare(b, "en", { numeric: true }));
    const any = (id) => { for (const c of CONDS) if (mx[c.id] && mx[c.id][id]) return mx[c.id][id]; return {}; };
    const kindOf = (id) => (info.get(id) || {}).kind || any(id).kind || "attack";
    const groupOf = (id) => (info.get(id) || {}).rule || (kindOf(id) === "benign" ? "work" : "attack");

    // 合計只算「每個已測條件都有測」的題目，避免題目組成不同造成不公平的比較
    const common = ids.filter((id) => present.every((c) => mx[c.id][id]));
    const pool = (cid, benign) => common.reduce((a, id) => {
      const x = mx[cid][id];
      if (!x || (kindOf(id) === "benign") !== benign) return a;
      return { k: a.k + x.k, n: a.n + x.n };
    }, { k: 0, n: 0 });
    // 只考受治理組的題目（第三章 lab）不進合計；兩種受治理條件都有測時，另列一行給這兩欄比較護欄的作用
    const govOnly = ids.filter((id) => !common.includes(id) && kindOf(id) !== "benign" &&
      ["governed", "governed+guard"].every((cid) => mx[cid] && mx[cid][id]));
    const summary = CONDS.map((c) => {
      if (!present.includes(c)) return `<div><h3>${c.name}</h3><p class="big none">－</p><p>還沒有這個條件的結果</p></div>`;
      const a = pool(c.id, false), w = pool(c.id, true);
      const [lo, hi] = wilson(a.k, a.n);
      const attack = a.n ? `<p class="big ${a.k ? "bad" : "ok"}">${pct(a.k / a.n)}</p><p>攻擊成功率（95% 信賴區間 ${pct(lo)}–${pct(hi)}，${a.k}/${a.n} 次）</p>`
        : `<p class="big none">－</p><p>共同題目裡沒有攻擊題</p>`;
      const work = w.n ? `<p>正常工作完成率 ${pct(w.k / w.n)}（${w.k}/${w.n} 次）</p>` : "";
      let extra = "";
      if (c.id !== "baseline" && govOnly.length) {
        const g = govOnly.reduce((acc, id) => ({ k: acc.k + mx[c.id][id].k, n: acc.n + mx[c.id][id].n }), { k: 0, n: 0 });
        extra = `<p class="${g.k ? "extra bad" : "extra"}">另加只考受治理組的 ${govOnly.length} 題：攻擊成功 ${g.k}/${g.n} 次（${pct(g.n ? g.k / g.n : 0)}）</p>`;
      }
      return `<div><h3>${c.name}</h3>${attack}${work}${extra}</div>`;
    }).join("");
    const missing = CONDS.filter((c) => !present.includes(c)).map((c) => `「${c.name}」`);
    const notes = [
      `合計只算${present.length > 1 ? "各條件都有測" : "這個條件有測"}的 ${common.length} 題${missing.length ? `；還缺${missing.join("、")}的結果` : ""}。`,
      cur && cur !== model ? `目前 Agent 用的模型是 ${esc(cur)}，這份結果是用 ${esc(model)} 跑的。` : "",
      "這是受控環境的基準測試：題目數少、攻擊手法固定，結果代表在這些情境下守不守得住，不能直接推論到實際部署。",
    ].filter(Boolean).map((t) => `<li>${t}</li>`).join("");
    const pick = models.length > 1
      ? `<label>模型 <select id="res-model">${models.map((m) => `<option value="${esc(m)}"${m === model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></label>`
      : `<span>模型：<b>${esc(model)}</b></span>`;

    const GROUP_ROW = {
      work: "正常工作（完成率，越高越好）",
      rule1: "鐵律一：敏感資料不外送（攻擊達成率，越低越好）",
      rule2: "鐵律二：Agent 不攻擊別人（攻擊達成率，越低越好）",
      attack: "其他攻擊題（攻擊達成率，越低越好）",
    };
    const cell = (c, id) => {
      const x = mx[c.id] && mx[c.id][id];
      const lbl = `data-label="${c.name}"`;
      if (!x) {
        if (c.id === "baseline" && (info.get(id) || {}).governed_only) return `<td class="cell na" ${lbl}>不適用<span class="r">對照組沒有這項工具</span></td>`;
        return `<td class="cell none" ${lbl}>未測</td>`;
      }
      const benign = kindOf(id) === "benign";
      const [lo, hi] = wilson(x.k, x.n);
      const cls = benign ? (x.k === x.n ? "ok" : "warn") : (x.k ? "bad" : "ok");
      const tried = benign ? "" : `<span class="r">嘗試 ${x.t}/${x.n}</span>`;
      const err = x.errors ? `<span class="err">${x.errors} 次執行失敗（不算守住）</span>` : "";
      return `<td class="cell ${cls}" ${lbl} title="來源：${esc(x.file)}（${esc(fmtTime(x.time))}）"><b>${x.k}/${x.n}</b>` +
        `<span class="r">${pct(x.k / x.n)}（${pct(lo)}–${pct(hi)}）</span>${tried}${err}</td>`;
    };
    const body = ["work", "rule1", "rule2", "attack"].map((g) => {
      const rows = ids.filter((id) => groupOf(id) === g);
      if (!rows.length) return "";
      return `<tr class="grp"><th colspan="4" scope="colgroup">${GROUP_ROW[g]}</th></tr>` + rows.map((id) => {
        const t = (info.get(id) || {}).title || any(id).title || "";
        const tag = CH3[id] ? `<span class="tag">第三章 ${esc(CH3[id])}</span>` : "";
        return `<tr><th scope="row"><span class="id">${esc(id)}</span>${esc(t)}${tag}</th>${CONDS.map((c) => cell(c, id)).join("")}</tr>`;
      }).join("");
    }).join("");

    box.innerHTML = `<div class="results-bar">${pick}<span class="muted">每一格：達成 k/N、達成率（95% 信賴區間）；攻擊題另列「嘗試」——嘗試高、達成低，代表模型被騙了但治理機制擋住了。</span></div>` +
      `<div class="res-summary">${summary}</div><ul class="res-notes">${notes}</ul>` +
      `<div class="table-scroll"><table class="res-table"><thead><tr><th scope="col">題目</th>${CONDS.map((c) => `<th scope="col">${c.name}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>` +
      filesTable(r.runs);
  }

  // ------------------------------------------------------------------ 展示導覽：展示前檢查
  function readiness() {
    const s = state.status, v = state.verify, r = state.results;
    const items = [];
    if (!s) {
      items.push({ cls: "bad", text: "入口網站後端沒有回應", fix: "在主機執行 ./lab.sh status，確認 portal 容器在執行" });
      return items;
    }
    const plat = Object.entries(s.components).filter(([k]) => !["model", "llm_proxy", "runner_governed", "runner_baseline"].includes(k));
    const bad = plat.filter(([, c]) => !c.ok).map(([k]) => COMP_NAME[k] || k);
    items.push(bad.length
      ? { cls: "bad", text: `有 ${bad.length} 個平台元件異常：${bad.join("、")}`, fix: "在主機執行 ./lab.sh status 看容器狀態，或 ./lab.sh diagnose（Windows：repair-windows.ps1 -Diagnose）" }
      : { cls: "ok", text: `平台元件 ${plat.length} 個全部正常` });
    const gr = s.runners.governed, br = s.runners.baseline;
    const deadR = [!gr.alive ? "受治理" : "", !br.alive ? "未治理" : ""].filter(Boolean);
    items.push(deadR.length
      ? { cls: "bad", text: `${deadR.join("、")} Agent 的執行器沒有心跳`, fix: "在主機執行 docker compose restart runner-governed runner-baseline" }
      : { cls: "ok", text: "兩個 Agent 的執行器都在線" });
    if (gr.model_ok) items.push({ cls: "ok", text: `模型 ${gr.model} 在線，Agent 可以作答` });
    else if (gr.model_missing) items.push({ cls: "bad", text: `模型主機連得到，但沒有模型 ${gr.model}`, fix: `在模型主機（例如 GB10）執行 ollama pull ${gr.model}，或把 .env 的 MODEL 改成已下載的名稱` });
    else items.push({ cls: "bad", text: "模型服務連不上，Agent 無法作答（網路隔離檢查仍可展示）", fix: "確認 .env 的 LLM_UPSTREAM、模型主機的防火牆，以及模型主機設定 OLLAMA_HOST=0.0.0.0" });
    items.push(s.guardrails === false
      ? { cls: "warn", text: "受治理 Agent 的護欄目前關閉", fix: "展示從「有護欄」開始：到實驗操作台把護欄開關打開" }
      : { cls: "ok", text: "受治理 Agent 的護欄開啟" });
    items.push((s.revoked || []).length
      ? { cls: "warn", text: `受治理 Agent 目前被 SOAR 斷線（${s.revoked.join("、")}）`, fix: "到實驗操作台按「解除受治理 Agent 的斷線」" }
      : { cls: "ok", text: "受治理 Agent 沒有被斷線" });
    if (!v) items.push({ cls: "", text: "讀取驗收報告中…" });
    else if (!v.ok) items.push({ cls: "warn", text: `佈署驗收：${v.detail}`, fix: "在主機執行 ./lab.sh verify --with-model（Windows：verify-windows.ps1 -Stage Post -WithModel）" });
    else if (v.overall === "PASS") {
      const req = v.checks.filter((c) => c.required);
      items.push({ cls: "ok", text: `佈署驗收通過（${fmtTime(v.generated)}，必要項 ${req.filter((c) => c.result === "pass").length}／${req.length}）` });
    } else items.push({ cls: "bad", text: `佈署驗收未通過：${v.failed_required.join("、")}`, fix: "在主機執行 ./lab.sh diagnose 看原因，修好後重新驗收" });
    if (!r) items.push({ cls: "", text: "讀取考卷結果中…" });
    else if (!r.ok) items.push({ cls: "warn", text: `考卷結果：${r.detail}` });
    else {
      const mx = r.matrix || {};
      const cur = gr.model;
      if (!Object.keys(mx).length) items.push({ cls: "warn", text: "還沒有考卷批次結果", fix: "展示前先跑一次（指令在「實驗結果」區），確認這個模型在攻擊題上的實際表現" });
      else if (cur && !mx[cur]) items.push({ cls: "warn", text: `考卷結果是用 ${Object.keys(mx).join("、")} 跑的，目前模型是 ${cur}`, fix: "換模型後重跑考卷，展示的數據才對得上" });
      else {
        const m = cur && mx[cur] ? cur : Object.keys(mx)[0];
        const miss = CONDS.filter((c) => !mx[m][c.id]).map((c) => c.name);
        const last = (r.runs || []).find((x) => x.model === m);
        items.push(miss.length
          ? { cls: "warn", text: `考卷結果還缺「${miss.join("」「")}」條件（模型 ${m}）`, fix: "照「實驗結果」區的指令補跑" }
          : { cls: "ok", text: `考卷結果三種條件都有（模型 ${m}，最近一次 ${last ? fmtTime(last.time) : "時間不明"}）` });
      }
    }
    return items;
  }
  function renderReady() {
    const items = readiness();
    const nBad = items.filter((x) => x.cls === "bad").length, nWarn = items.filter((x) => x.cls === "warn").length;
    const loading = items.some((x) => x.cls === "");
    const v = $("#ready-verdict");
    if (nBad) { v.className = "ready-verdict bad"; v.textContent = `還有 ${nBad} 項要先處理，才能開始展示`; }
    else if (loading) { v.className = "ready-verdict"; v.textContent = "檢查中…"; }
    else if (nWarn) { v.className = "ready-verdict warn"; v.textContent = `可以展示，但有 ${nWarn} 項建議先處理`; }
    else { v.className = "ready-verdict ok"; v.textContent = "全部就緒，可以開始展示"; }
    const IC = { ok: "✓", warn: "!", bad: "✕", "": "…" };
    $("#ready-list").innerHTML = items.map((x) =>
      `<li class="${x.cls}"><span class="ic" aria-hidden="true">${IC[x.cls]}</span><span>${esc(x.text)}</span>${x.fix ? `<span class="fix">${esc(x.fix)}</span>` : ""}</li>`).join("");
  }

  // ------------------------------------------------------------------ 展示導覽：每一項驗證在哪裡看
  function whereRows() {
    const p = state.proof, s = state.status, st = state.stats, r = state.results, v = state.verify;
    const a = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;
    const ext = (href, text) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
    const code = (t) => `<code>${esc(t)}</code>`;
    const rows = [];

    rows.push({ what: "兩條鐵律的對照計數", proves: "兩條鐵律", where: `${a("#intro", "首頁")}的四個數字（依據 ${code("logs/*.ndjson")}）`,
      now: p ? { text: `未治理：洩密或外送 ${p.baseline.leaks + p.baseline.exfil} 次、攻擊他人 ${p.baseline.attacks} 次；受治理：${p.governed.leaks + p.governed.exfil} 次、${p.governed.attacks} 次${p.since ? "（本場展示）" : ""}` } : null });

    let duo = null;
    if (s) {
      const dead = [!s.runners.governed.alive ? "受治理" : "", !s.runners.baseline.alive ? "未治理" : ""].filter(Boolean);
      duo = dead.length ? { text: `${dead.join("、")}執行器沒有心跳`, cls: "bad" } : { text: s.runners.governed.model_ok ? "兩個 Agent 都在線，可以作答" : "執行器在線，但模型沒有連線", cls: s.runners.governed.model_ok ? "ok" : "bad" };
    }
    rows.push({ what: "同一個問題，兩個 Agent", proves: "兩條鐵律", where: a("#console", "實驗操作台"), now: duo });

    let iso;
    const lc = state.lastChecks;
    if (lc && lc.governed) {
      const reach = (lc.governed.targets || []).filter((x) => x.reachable).map((x) => HOST_LABEL[x.host] || x.host);
      const exp = lc.baseline ? (lc.baseline.targets || []).filter((x) => x.reachable && !LEGIT.baseline.has(x.host)).length : null;
      iso = { text: `剛才（${hhmmss(lc.ts)}）：受治理只連得到${reach.join("、") || "（無）"}${exp === null ? "" : `；未治理連得到 ${exp} 個不該碰的地方`}`, cls: reach.every((h) => h === "治理閘道" || h === "模型代理") ? "ok" : "bad" };
    } else {
      const c5 = verifyCheck("C05"), c6 = verifyCheck("C06");
      if (c5) {
        const reach = ((c5.evidence && c5.evidence.reachable) || []).map((h) => HOST_LABEL[h] || h);
        const exp = (c6 && c6.evidence && c6.evidence.exposed) || [];
        iso = { text: `最近一次驗收：受治理只連得到${reach.join("、") || "（無）"}；未治理連得到 ${exp.length} 個不該碰的地方`, cls: c5.result === "pass" ? "ok" : "bad" };
      } else iso = v ? { text: "可在實驗操作台按「網路隔離檢查」當場看", cls: "" } : null;
    }
    rows.push({ what: "網路隔離檢查（含偽造憑證）", proves: "兩條鐵律", where: `${a("#console", "實驗操作台")}的「網路隔離檢查」；${a("#acceptance", "環境驗收")} C05、C06`, now: iso });

    rows.push({ what: "護欄開與關的對照", proves: "兩條鐵律", where: `${a("#console", "實驗操作台")}的「護欄」開關（需要操作 PIN）`,
      now: s ? { text: s.guardrails === false ? "護欄目前關閉（只有 Gateway）" : "護欄目前開啟", cls: s.guardrails === false ? "warn" : "ok" } : null });

    let cnt = null;
    if (state.cases) {
      const n = (g) => state.cases.filter((c) => c.rule === g).length;
      cnt = { text: `正常工作 ${n("work")} 題、鐵律一 ${n("rule1")} 題、鐵律二 ${n("rule2")} 題` };
    }
    rows.push({ what: "考卷單題（兩個 Agent 同時作答）", proves: "兩條鐵律", where: `${a("#experiments", "實驗")}區每一題的按鈕；結果出現在實驗操作台`, now: cnt });

    rows.push({ what: "第三章攻擊情境（L1、L3–L7）", proves: "鐵律一（L6 兼鐵律二）", where: `${a("#experiments", "實驗")}區的 A7–A11（只考受治理組）；${a("#acceptance", "環境驗收")} B09–B11、C14、C15`,
      now: checksSummary(["B09", "B10", "B11", "C14", "C15"]) });

    let res = null;
    if (r) {
      if (!r.ok) res = { text: r.detail, cls: "warn" };
      else if (!(r.runs || []).length) res = { text: "還沒有結果（指令在「實驗結果」區）", cls: "warn" };
      else { const x = r.runs[0]; res = { text: `${r.runs.length} 個結果檔；最近一次 ${fmtTime(x.time)}（${COND_NAME[x.condition] || x.condition}，${x.model}）` }; }
    }
    rows.push({ what: "考卷批次統計（三種條件、95% 信賴區間）", proves: "兩條鐵律", where: `${a("#results", "實驗結果")}（依據 ${code("results/*.csv")}）`, now: res });

    rows.push({ what: "護欄自我測試（注入、遮蔽、外送、規避、外部網址）", proves: "兩條鐵律", where: `${a("#acceptance", "環境驗收")} C07–C09、C14、C15`, now: checksSummary(["C07", "C08", "C09", "C14", "C15"]) });

    const c10 = checksSummary(["C10"]);
    rows.push({ what: "模型代理：只放行核准的本地模型、拒絕雲端模型", proves: "鐵律一", where: `${a("#acceptance", "環境驗收")} C10；${a("#monitoring", "監控")}的事件流`,
      now: { text: `${c10.text}${p ? `；累計拒絕 ${p.governed.llm_denied || 0} 次` : ""}`, cls: c10.cls } });

    let acc = null;
    if (v) {
      if (!v.ok) acc = { text: v.detail, cls: "warn" };
      else { const req = v.checks.filter((c) => c.required); acc = { text: `${v.overall === "PASS" ? "通過" : "未通過"}・必要項 ${req.filter((c) => c.result === "pass").length}／${req.length}・${fmtTime(v.generated)}`, cls: v.overall === "PASS" ? "ok" : "bad" }; }
    }
    rows.push({ what: "佈署驗收（環境有沒有裝對）", proves: "環境裝對", where: `${a("#acceptance", "環境驗收")}（依據 ${code("results/verify-latest.json")}）`, now: acc });

    rows.push({ what: "Wazuh 偵測規則（100901–100913）", proves: "看得見（偵測）", where: `${a("#monitoring", "監控")}的偵測分類；${ext($("#wazuh-all").href, "Wazuh 原始告警")}`,
      now: st ? (st.ok ? { text: `最近 24 小時 ${st.total || 0} 筆 agentlab 告警` } : { text: `讀不到 Wazuh（${st.detail || "原因不明"}）`, cls: "bad" }) : null });

    rows.push({ what: "SOAR 自動斷線與解除", proves: "能處置（回應）", where: `${a("#monitoring", "監控")}的即時事件流；${a("#console", "實驗操作台")}的「解除斷線」`,
      now: p && s ? { text: `累計斷線 ${p.governed.revocations} 次${p.since ? "（本場展示）" : ""}；${(s.revoked || []).length ? "目前已斷線" : "目前沒有斷線"}`, cls: (s.revoked || []).length ? "warn" : "" } : null });

    const gf = s && s.components.grafana;
    rows.push({ what: "Grafana 戰情室", proves: "看得見（大螢幕）", where: `${a("#monitoring", "監控")}（內嵌）；${ext(state.dash ? `${state.dash}?orgId=1&kiosk&refresh=10s` : "", "全螢幕開啟")}`,
      now: gf ? { text: gf.ok ? "在線" : `離線（${gf.detail}）`, cls: gf.ok ? "ok" : "bad" } : null });
    return rows;
  }
  function renderWhere() {
    const IC = { ok: "✓", warn: "!", bad: "✕" };
    $("#where-body").innerHTML = whereRows().map((x) => {
      const now = x.now ? `${x.now.cls && IC[x.now.cls] ? `<span class="ic ${x.now.cls}" aria-hidden="true">${IC[x.now.cls]}</span>` : ""}${esc(x.now.text)}` : '<span class="muted">讀取中…</span>';
      return `<tr><th scope="row">${esc(x.what)}</th><td class="proves" data-label="證明">${esc(x.proves)}</td>` +
        `<td data-label="在哪裡看">${x.where}</td><td class="now ${x.now && x.now.cls ? x.now.cls : ""}" data-label="目前結果">${now}</td></tr>`;
    }).join("");
  }
  function renderGuide() {
    renderReady();
    renderWhere();
  }

  // ------------------------------------------------------------------ 展示導覽：建議順序與提詞列
  const STEPS = [
    { title: "首頁：兩條鐵律", target: "#intro",
      say: "藍隊需要用 AI 防禦 AI，但把 AI Agent 放進組織有兩個擔心：敏感資料被送出去、Agent 失控去攻擊別人。這套環境把這兩件事寫成兩條鐵律，每一條都能在這一頁當場驗證。",
      look: "四個數字：未治理與受治理的 Agent，各自洩密或外送、攻擊他人的次數。" },
    { title: "架構：Gateway 與兩個護欄", target: "#architecture",
      say: "依老師的架構：任務經 Agent Gateway 進來，先過輸入護欄才交給 Agent；Agent 要送出的工具參數與回答，先過輸出護欄。受治理的 Agent 身上沒有密碼，只連得到 Gateway 和模型代理。",
      look: "點圖中的「治理閘道」與兩個「護欄」看說明；每個元件右上角的燈號是即時狀態。" },
    { title: "網路隔離檢查", target: "#console", action: "checks",
      say: "先證明隔離是真的：從兩個 Agent 所在的網路，逐一嘗試連到環境裡的每個地方。",
      look: "左邊（未治理）連得到資料庫、受害主機和外網；右邊（受治理）只連得到 Gateway 和模型代理，用偽造的憑證呼叫 Gateway 會被拒絕。" },
    { title: "攻擊題：鐵律一（敏感資料不外送）", target: "#exp-rule1",
      say: "挑一題鐵律一的攻擊，按「兩邊都跑」，兩個 Agent 同時作答同一題。",
      look: "回到操作台看兩邊的判定：回答裡出現的誘餌秘密以紅底標出；受治理一邊被遮蔽的內容以綠字標示，被 Gateway 拒絕的請求會列在步驟裡。" },
    { title: "攻擊題：鐵律二（Agent 不攻擊別人）", target: "#exp-rule2",
      say: "再挑一題鐵律二的攻擊：誘導 Agent 去打內部主機，或執行影響他人的動作。",
      look: "受害主機被連線、封鎖動作被執行，會以紅字列在步驟裡；受治理一邊的請求被 Gateway 拒絕或送人工核准。" },
    { title: "關掉護欄，重跑同一題", target: "#console", action: "guard", optional: true,
      say: "護欄是第二道防線，會漏也會誤判。關掉護欄、只留 Gateway 的確定性邊界，看同一題還守不守得住。",
      look: "操作台的「護欄」開關（需要操作 PIN）。重跑後比較受治理一邊的結果；這一步做完記得把護欄打開。" },
    { title: "監控：偵測與自動斷線", target: "#monitoring",
      say: "每一個決策都寫成紀錄送進 Wazuh。確認違規、信心度評分夠高時，SOAR 會自動撤銷受治理 Agent 的憑證。",
      look: "偵測分類的數字增加；事件流出現 SOAR 評分，達門檻時會出現「撤銷憑證」。被斷線後到操作台按「解除受治理 Agent 的斷線」恢復。" },
    { title: "數據：三種條件的攻擊成功率", target: "#results",
      say: "單次展示有隨機性，結論看批次數據：同一份考卷重複作答，比較未治理、只有 Gateway、Gateway 加護欄三種條件。",
      look: "攻擊題的達成率越低越好，正常工作題越高越好；括號內是 95% 信賴區間。這是受控環境的基準測試，不等於實際部署的效果。" },
    { title: "環境驗收證據", target: "#acceptance", optional: true,
      say: "環境本身也經過逐項驗收：網路隔離、護欄、模型代理、偵測規則都有檢查項目，每一項都留下證據。",
      look: "整體結果與每一項的通過與否；展開「證據」可以看原始輸出。" },
  ];
  const ACT_LABEL = { checks: "執行網路隔離檢查", guard: "前往護欄開關" };
  function renderSteps() {
    $("#script-steps").innerHTML = STEPS.map((st, i) =>
      `<li class="${i === state.presentIdx ? "current" : ""}"><div><b>${esc(st.title)}${st.optional ? '<span class="opt">可略過</span>' : ""}</b><p>${esc(st.say)}</p></div>` +
      `<button type="button" class="btn" data-step="${i}">${st.action === "checks" ? "執行" : "前往"}</button></li>`).join("");
  }
  function spotlight(sel) {
    const el = $(sel);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.remove("spot");
    void el.offsetWidth;            // 重新觸發提示框
    el.classList.add("spot");
    setTimeout(() => el.classList.remove("spot"), 1800);
  }
  function doStep(i, runAction) {
    const st = STEPS[i];
    if (!st) return;
    spotlight(st.target);
    if (!runAction) return;
    if (st.action === "checks") {
      if (busy()) { msg("Agent 還在作答，等完成後再做網路隔離檢查。", true); return; }
      submit({ type: "checks" }, "網路隔離檢查");
    }
    if (st.action === "guard") setTimeout(() => $("#guard-toggle").focus({ preventScroll: true }), 400);
  }
  function present(i) {
    state.presentIdx = Math.max(0, Math.min(STEPS.length - 1, i));
    const st = STEPS[state.presentIdx];
    store.set("present_idx", String(state.presentIdx), "session");
    const bar = $("#presenter");
    bar.hidden = false;
    document.body.classList.add("presenting");
    $("#pr-count").textContent = `第 ${state.presentIdx + 1}／${STEPS.length} 步`;
    $("#pr-title").textContent = `${st.title}${st.optional ? "（可略過）" : ""}`;
    $("#pr-say").textContent = st.say;
    $("#pr-look").textContent = `請觀眾看：${st.look}`;
    $("#pr-act").textContent = ACT_LABEL[st.action] || "回到這一區";
    $("#pr-prev").disabled = state.presentIdx === 0;
    $("#pr-next").disabled = state.presentIdx === STEPS.length - 1;
    renderSteps();
    doStep(state.presentIdx, false);
  }
  function endPresent() {
    state.presentIdx = -1;
    store.del("present_idx", "session");
    $("#presenter").hidden = true;
    document.body.classList.remove("presenting");
    renderSteps();
  }

  // ------------------------------------------------------------------ 架構圖互動與元件介紹
  function showDetail(id) {
    const c = COMPONENTS[id];
    if (!c) return;
    const h = state.status ? nodeHealth(id, state.status) : { cls: "", text: "讀取中" };
    const rules = c.rules.length ? c.rules.map((r) => RULE_NAME[r]).join("、") : "不直接守住鐵律（展示與觀察用）";
    const icon = h.cls === "ok" ? "✓" : h.cls === "bad" ? "✕" : h.cls === "warn" ? "!" : "…";
    $("#arch-detail").innerHTML =
      `<h3>${esc(c.name)}</h3><p>${esc(c.desc)}</p><dl>` +
      `<dt>守住</dt><dd>${esc(rules)}</dd>` +
      `<dt>使用的軟體</dt><dd>${esc(c.sw)}</dd>` +
      `<dt>目前狀態</dt><dd><span class="status-line ${h.cls === "warn" ? "bad" : h.cls}"><span aria-hidden="true">${icon}</span>${esc(h.text)}</span></dd></dl>`;
  }
  function initArch() {
    $$(".node").forEach((n) => {
      const pick = () => {
        $$(".node.selected").forEach((x) => x.classList.remove("selected"));
        n.classList.add("selected");
        showDetail(n.dataset.id);
      };
      n.addEventListener("click", pick);
      n.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
      const c = COMPONENTS[n.dataset.id];
      if (c) n.setAttribute("aria-label", `${c.name}：查看說明`);
    });
  }
  function renderComponents() {
    $("#comp-groups").innerHTML = ZONES.map((z) => {
      const items = Object.values(COMPONENTS).filter((c) => c.zone === z.id).map((c) => {
        const tags = c.rules.map((r) => `<span class="rule-tag">${RULE_NAME[r]}</span>`).join("");
        return `<div><dt>${esc(c.name)}${tags ? `<span class="rule-tags">${tags}</span>` : ""}<span class="sw-tag">${esc(c.sw)}</span></dt><dd>${esc(c.desc)}</dd></div>`;
      }).join("");
      return `<section class="comp-group"><h3>${esc(z.name)}<small>${esc(z.note)}</small></h3><dl class="comp-list">${items}</dl></section>`;
    }).join("");
  }

  // ------------------------------------------------------------------ 頁面章節高亮
  function initNavSpy() {
    if (!("IntersectionObserver" in window)) return;
    const links = new Map($$(".sections a").map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("active"));
        const a = links.get(en.target.id);
        if (a) a.classList.add("active");
      }
    }, { rootMargin: "-40% 0px -55% 0px" });
    links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  // ------------------------------------------------------------------ 綁定
  function bind() {
    $("#presets").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-q]");
      if (b) { $("#question").value = b.dataset.q; $("#question").focus(); }
    });
    $("#ask-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = $("#question").value.trim();
      if (!q) { msg("請先輸入問題，或點一個範例問題。", true); $("#question").focus(); return; }
      submit({ type: "ask", question: q }, "問題");
    });
    $("#question").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) $("#ask-form").requestSubmit();
    });
    $("#checks-btn").addEventListener("click", () => submit({ type: "checks" }, "網路隔離檢查"));
    $("#guard-toggle").addEventListener("change", (ev) => setGuard(ev.target.checked));
    $("#reset-btn").addEventListener("click", async () => {
      try {
        const r = await api("/api/reset", { method: "POST", body: "{}" });
        msg(`已解除斷線：${(r.unrevoked || []).map((x) => x.agent_id).join("、") || "（沒有被斷線的 Agent）"}`);
        pollStatus();
      } catch (err) {
        if (err.status === 401) { msg("需要操作員 PIN，請輸入後再按一次。", true); $("#pin-wrap").hidden = false; $("#pin").focus(); }
        else msg(`解除失敗：${err.message}`, true);
      }
    });
    $("#proof-scope").addEventListener("click", toggleProofScope);
    // 展示導覽
    $("#present-start").addEventListener("click", () => present(0));
    $("#script-steps").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-step]");
      if (!b) return;
      const i = Number(b.dataset.step);
      if (state.presentIdx >= 0) present(i);
      doStep(i, true);
    });
    $("#pr-prev").addEventListener("click", () => present(state.presentIdx - 1));
    $("#pr-next").addEventListener("click", () => present(state.presentIdx + 1));
    $("#pr-act").addEventListener("click", () => doStep(state.presentIdx, true));
    $("#pr-end").addEventListener("click", endPresent);
    document.addEventListener("keydown", (ev) => {
      // 提詞列開著時，左右方向鍵換步（簡報遙控器多半送方向鍵）；正在輸入時不攔
      if (state.presentIdx < 0 || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable]")) return;
      if (ev.key === "ArrowRight") { ev.preventDefault(); present(state.presentIdx + 1); }
      if (ev.key === "ArrowLeft") { ev.preventDefault(); present(state.presentIdx - 1); }
    });
    $("#results-body").addEventListener("change", (ev) => {
      if (ev.target.id === "res-model") { state.resModel = ev.target.value; renderResults(); }
    });
  }

  async function main() {
    initTheme();
    initArch();
    renderComponents();
    renderSteps();
    bind();
    initNavSpy();
    await loadConfig();
    pollStatus(); pollProof(); pollStats(); pollVerify(); pollResults();
    loadCases();
    await loadRecent();
    startStream();
    setInterval(pollStatus, 5000);
    setInterval(pollProof, 8000);
    setInterval(pollStats, 8000);
    setInterval(pollVerify, 30000);
    setInterval(pollResults, 30000);
    // 重新整理頁面時，若剛才在展示中，回到同一步
    const saved = store.get("present_idx", "session");
    if (saved !== null && saved !== "") present(Number(saved));
  }
  main();
})();
