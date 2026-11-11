/* portal.js — 入口網站前端
   資料來源（全部由 portal.py 提供）：
     /api/config  埠號、是否需要 PIN
     /api/status  各元件健康、執行器心跳、模型是否在線、被撤銷的 Agent   （每 5 秒）
     /api/proof   兩條鐵律的對照計數（從紀錄檔計算）                      （每 8 秒）
     /api/stats   Wazuh 告警分類計數                                       （每 8 秒）
     /api/cases   考卷題目（只有標題，不含題目原文）
     /api/run     送出工作；/api/jobs/... 查結果（每 1.5 秒）
     /api/stream  即時事件（SSE）
*/
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, area = "local") { try { return (area === "local" ? localStorage : sessionStorage).getItem(k); } catch { return null; } },
    set(k, v, area = "local") { try { (area === "local" ? localStorage : sessionStorage).setItem(k, v); } catch { /* 無痕或封鎖儲存時忽略 */ } },
  };

  const state = {
    config: { pin_required: false, grafana_port: "3000", wazuh_port: "8443" },
    status: null,
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
  };

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
      syncGuard(s.guardrails);
      const revoked = (s.revoked || []).length > 0;
      $("#reset-btn").hidden = !revoked;
      if (state.lanes.governed.state === "idle") setLaneState("governed", revoked ? "error" : "idle", revoked ? "已被斷線" : "待命");
      const sel = $(".node.selected");
      if (sel) showDetail(sel.dataset.id);
    } catch {
      const pill = $("#health-pill");
      pill.textContent = "入口網站後端沒有回應";
      pill.className = "health-pill bad";
    }
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
      const p = await api("/api/proof");
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
      $("#proof-note").textContent =
        `計數來自本環境的紀錄（自這次部署起）：未治理 Agent 作答 ${p.baseline.runs} 次、受治理 Agent 作答 ${g.runs} 次；` +
        `Gateway 共擋下 ${g.denied} 個請求、送人工核准 ${g.pending} 個；護欄攔下 ${g.guard_blocked || 0} 次、遮蔽 ${g.guard_redacted || 0} 次；` +
        `模型代理拒絕 ${g.llm_denied || 0} 次；SOAR 斷線 ${g.revocations} 次。每 8 秒更新。`;
    } catch { /* 下次再試 */ }
  }

  // ------------------------------------------------------------------ Wazuh 偵測統計
  async function pollStats() {
    try {
      const s = await api("/api/stats?window=24h");
      const ul = $("#bars");
      if (!s.ok) { ul.innerHTML = `<li class="muted">讀不到 Wazuh 資料（${esc(s.detail)}）</li>`; return; }
      const ids = Object.keys(RULE_LABELS);
      const max = Math.max(1, ...ids.map((i) => s.by_rule[i] || 0));
      ul.innerHTML = ids.map((i) => {
        const n = s.by_rule[i] || 0;
        return `<li><span>${esc(RULE_LABELS[i])}</span><span class="track"><span class="fill ${n ? "" : "zero"}" style="width:${(n / max) * 100}%"></span></span><span class="n">${n}</span></li>`;
      }).join("");
      const lb = s.leak_by_mode || {};
      $("#bars-total").textContent = `共 ${s.total || 0} 筆 agentlab 告警（含一般事件）。誘餌外洩：未治理 ${lb.baseline || 0} 次，受治理 ${lb.governed || 0} 次。`;
    } catch { /* 下次再試 */ }
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
    msg(`${kindLabel}已送出，兩個 Agent 同時作答中。`);
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
    document.getElementById("console").scrollIntoView({ block: "start" });
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
    if (r.type === "checks") box.innerHTML = renderChecks(target, res);
    else box.innerHTML = renderAnswer(r, res);
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
    box.innerHTML = GROUPS.map((g) => {
      const items = cases.filter((c) => c.rule === g.rule).map((c) =>
        `<li><span><span class="id">${esc(c.id)}</span>${esc(c.title)}<span class="last" id="last-${esc(c.id)}"></span></span>` +
        `<button type="button" data-case="${esc(c.id)}">兩邊都跑</button></li>`).join("");
      return `<div class="exp-group"><h3>${g.title}</h3><p>${g.note}</p><ul>${items || '<li class="muted">（沒有題目）</li>'}</ul></div>`;
    }).join("");
    box.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-case]");
      if (b) submit({ type: "test", case_id: b.dataset.case }, `題目 ${b.dataset.case} `);
    });
    setBusy();
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
  }

  async function main() {
    initTheme();
    initArch();
    renderComponents();
    bind();
    initNavSpy();
    await loadConfig();
    pollStatus(); pollProof(); pollStats();
    loadCases();
    await loadRecent();
    startStream();
    setInterval(pollStatus, 5000);
    setInterval(pollProof, 8000);
    setInterval(pollStats, 8000);
  }
  main();
})();
