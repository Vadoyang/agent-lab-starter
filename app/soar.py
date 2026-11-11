"""soar.py — 輕量 SOAR 決策層（Decide → Enforce）

對應老師 SOAR 文件的「SIEM 偵測 → SOAR 調整 PEP 做動態存取控制」，以及信心度評分框架
（V1–V5 → AUTO_BLOCK / NOTIFY_SOC / LOG_ONLY）。本服務是第一階段「自足模擬」用的輕量版：

  Wazuh 告警 ──(官方 <integration> push)──▶ /webhook
      │  依 V1–V5 計算信心度評分（evidence 可審計）
      ▼
  AUTO_BLOCK ─▶ 呼叫 toolproxy 撤銷該 agent 的 token（PEP：動態存取控制）
  NOTIFY_SOC ─▶ 寫待人工核准
  LOG_ONLY   ─▶ 只記錄

第二階段併入正式 SOAR 專案時，本服務的評分邏輯搬到 Shuffle Workflow 節點、
enforcement 從「撤銷 token」擴充為真實 PEP（PA 防火牆 / 路由器 / AD）。評分結構與
evidence 格式刻意與信心度評分框架 v1.1 一致，確保可直接對接。
"""
from __future__ import annotations

import datetime
import os

import httpx
from fastapi import Body, FastAPI
from fastapi.responses import JSONResponse

from common import indexer_request, log_event, read_events

TOOLPROXY_URL = os.getenv("TOOLPROXY_URL", "http://toolproxy:8000").rstrip("/")
SOAR_ADMIN_TOKEN = os.getenv("SOAR_ADMIN_TOKEN", "")
# 閾值（對齊信心度評分框架：情境一/二 AUTO_BLOCK≥70、NOTIFY≥40）
AUTO_BLOCK = int(os.getenv("AUTO_BLOCK_THRESHOLD", "70"))
NOTIFY = int(os.getenv("NOTIFY_THRESHOLD", "40"))

app = FastAPI(title="soar")


# V5 的「上班時間」要用當地時間判斷；Wazuh 告警的 timestamp 是 UTC（+0000）
try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo(os.getenv("SOAR_TZ", "Asia/Taipei"))
except Exception:  # noqa: BLE001
    LOCAL_TZ = datetime.timezone(datetime.timedelta(hours=8))


def _hour(ts: str) -> int:
    try:
        t = ts.replace("Z", "+00:00")
        if len(t) > 5 and t[-5] in "+-" and t[-3] != ":":   # Wazuh 的 +0000 → +00:00
            t = t[:-2] + ":" + t[-2:]
        d = datetime.datetime.fromisoformat(t)
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d.astimezone(LOCAL_TZ).hour
    except Exception:  # noqa: BLE001
        return datetime.datetime.now(LOCAL_TZ).hour


def history_count(agent_id: str) -> int:
    """V3：這個 agent 過去 24h 的 agentlab 告警數（Wazuh indexer 查詢）。
    對應信心度框架 V3『歷史持續性』，資料來源與情境一的 Wazuh API 查詢等價。"""
    if not agent_id:
        return 0
    body = {"query": {"bool": {"must": [
        {"term": {"rule.groups": "agentlab"}},
        {"match": {"data.agent_id": agent_id}},
        {"range": {"timestamp": {"gte": "now-24h"}}},
    ]}}}
    try:
        r = indexer_request("POST", "/wazuh-alerts-*/_count", json=body)
        return int(r.json().get("count", 0)) if r.status_code < 300 else 0
    except Exception:  # noqa: BLE001
        return 0


def resolve_identity(data: dict) -> str | None:
    """找出「這筆告警是哪個受治理身分造成的」。只有經過治理閘道（PEP）的 Agent 才有身分可撤銷。

    1. 告警本身帶 agent_id（toolproxy 決策紀錄）→ 直接用
    2. 沒有的話，用 trace_id 回查 toolproxy 決策紀錄，找同一次任務的 agent_id
    3. 都找不到（例如未治理的 baseline Agent，它根本不經過 PEP）→ None，不撤銷任何人
    注意：sink-hits 的 role 是 victim/attacker，不是身分，不能拿來撤銷。
    """
    def real(v) -> str | None:
        # Wazuh 會把 JSON 的 null 解成字串 "null"（例如偽造憑證被拒的紀錄沒有身分）
        s = str(v).strip() if v is not None else ""
        return None if s.lower() in ("", "null", "none") else s

    if data.get("mode") == "baseline":
        return None
    if real(data.get("agent_id")):
        return real(data.get("agent_id"))
    trace = real(data.get("trace_id"))
    if trace:
        for e in read_events("toolproxy-decisions", trace):
            if real(e.get("agent_id")):
                return real(e.get("agent_id"))
    return None


def score_alert(alert: dict) -> dict:
    """依 V1–V5 計算信心度評分；回傳 score/action/evidence（格式對齊框架 v1.1）。"""
    rule = alert.get("rule", {})
    data = alert.get("data", {})
    level = int(rule.get("level", 0) or 0)
    groups = rule.get("groups", []) or []
    gset = set(groups)
    agent_id = resolve_identity(data)
    ts = alert.get("timestamp") or data.get("@timestamp") or datetime.datetime.now().isoformat()

    score = 0
    evidence: list[str] = []

    # V1 事件嚴重度 ← rule.level
    if level >= 12:
        score += 40; evidence.append(f"[+40] V1 Rule level {level}: critical  ← rule.level")
    elif level >= 10:
        score += 25; evidence.append(f"[+25] V1 Rule level {level}: high  ← rule.level")
    else:
        evidence.append(f"[ +0] V1 Rule level {level}: below threshold  ← rule.level")

    # V2 行為模式 ← rule.groups（AI agent 相關攻擊分類）
    if gset & {"data_leak", "exfiltration", "agentlab_secret_leak", "agentlab_exfil"}:
        score += 30; evidence.append("[+30] V2 secret leak / exfiltration  ← rule.groups")
    elif gset & {"agentlab_lateral", "attack"}:
        score += 25; evidence.append("[+25] V2 lateral movement / internal attack  ← rule.groups")
    elif gset & {"prompt_injection", "agentlab_injection"}:
        score += 20; evidence.append("[+20] V2 prompt injection  ← rule.groups")
    elif gset & {"agentlab_deny", "pep"}:
        score += 15; evidence.append("[+15] V2 policy violation (gateway deny)  ← rule.groups")
    else:
        evidence.append("[ +0] V2 no high-risk behavior tag  ← rule.groups")

    # V3 歷史持續性 ← Wazuh indexer（24h 同 agent 告警數）
    hist = history_count(agent_id or "")
    if hist >= 20:
        score += 20; evidence.append(f"[+20] V3 {hist} alerts/24h (persistent)  ← Wazuh indexer")
    elif hist >= 5:
        score += 10; evidence.append(f"[+10] V3 {hist} alerts/24h  ← Wazuh indexer")
    else:
        evidence.append(f"[ +0] V3 {hist} alerts/24h (low persistence)  ← Wazuh indexer")

    # V4 外部情資（第一階段內部環境不適用，保留掛鉤）
    evidence.append("[ +0] V4 external intel: n/a (internal lab)  ← -")

    # V5 時間與情境 ← timestamp
    h = _hour(ts)
    if h < 8 or h > 18:
        score += 10; evidence.append(f"[+10] V5 off-hours ({h}:00)  ← timestamp")
    else:
        evidence.append(f"[ +0] V5 business hours ({h}:00)  ← timestamp")

    action = "AUTO_BLOCK" if score >= AUTO_BLOCK else ("NOTIFY_SOC" if score >= NOTIFY else "LOG_ONLY")
    return {"score": score, "action": action, "agent_id": agent_id,
            "rule_id": rule.get("id"), "evidence": evidence, "timestamp": ts}


def enforce(decision: dict) -> dict:
    """依決策執行 PEP 動作。第一階段：AUTO_BLOCK → 撤銷 toolproxy 的 agent token。"""
    action, agent_id = decision["action"], decision["agent_id"]
    if action in ("AUTO_BLOCK", "NOTIFY_SOC") and not agent_id:
        # 判定要處置，但違規的是未經治理閘道的 Agent：沒有 PEP、沒有身分，SOC 無法把它斷線。
        # 這正是「未治理」的風險所在，記錄下來供戰情室與入口網站呈現。
        log_event("actions", {"action": "contain_failed", "executed": False, "mode": "soar",
                              "score": decision["score"], "rule_id": decision.get("rule_id"),
                              "reason": "未治理 Agent 未經 PEP，無可撤銷的身分"})
        return {"enforced": False, "pep_action": "unenforceable",
                "detail": "未治理 Agent 未經 PEP，無可撤銷的身分"}
    if action == "AUTO_BLOCK":
        enforced, detail = False, ""
        try:
            r = httpx.post(f"{TOOLPROXY_URL}/revoke",
                           json={"agent_id": agent_id, "reason": f"SOAR AUTO_BLOCK score={decision['score']}"},
                           headers={"X-Soar-Token": SOAR_ADMIN_TOKEN}, timeout=10)
            enforced = r.status_code < 300
            detail = r.text[:200]
        except Exception as e:  # noqa: BLE001
            detail = f"{type(e).__name__}: {e}"[:200]
        # 撤銷事件由 toolproxy /revoke 記錄一次即可（避免同一次撤銷被計兩次）；
        # 評分與證據完整寫在 soar-decisions。
        return {"enforced": enforced, "pep_action": "revoke_token", "detail": detail}
    if action == "NOTIFY_SOC":
        log_event("approvals", {"request_id": os.urandom(4).hex(), "action": "soar_review",
                               "agent_id": agent_id, "score": decision["score"], "status": "pending"})
        return {"enforced": False, "pep_action": "notify_soc"}
    return {"enforced": False, "pep_action": "log_only"}


# 只對「偵測類」告警評分；soar 自己的動作/基底/核准事件不回饋評分（避免迴圈與雜訊）
SKIP_GROUPS = {"agentlab_event", "agentlab_action", "agentlab_approval", "agentlab_response"}


@app.post("/webhook")
def webhook(payload: dict = Body(default={})):
    """接收 Wazuh <integration> push 的告警。Wazuh 會把整個 alert JSON 作為 body。"""
    alert = payload.get("alert", payload)   # 容錯：有些整合會包一層
    groups = set(alert.get("rule", {}).get("groups", []) or [])
    if groups & SKIP_GROUPS:                # 自己的動作/基底事件 → 不評分、不回饋
        return JSONResponse({"action": "IGNORED", "reason": "non-detection event"})
    decision = score_alert(alert)
    result = enforce(decision)
    # 寫決策事件（給 Wazuh/Grafana 呈現決策→執行的環路）
    log_event("soar-decisions", {**decision, **result})
    return JSONResponse({**decision, **result})


@app.get("/health")
def health():
    return {"ok": True, "auto_block": AUTO_BLOCK, "notify": NOTIFY}
