#!/usr/bin/env python3
"""agentlab_doctor.py — 佈署診斷與自動修復（給人，也給自動化佈署代理如 Codex 使用）

  ./lab.sh diagnose          收齊診斷資料，比對已知問題，寫 results/diagnose-latest.json
  ./lab.sh repair auto       依診斷結果自動套用「可自動修」的修法，修完重新診斷，最多 3 輪
  ./lab.sh repair F06        只套用指定修法
  ./lab.sh repair list       列出所有修法

設計原則（與 AGENTS.md 一致）：
  · 只修「佈署層」問題：服務沒起來、設定沒生效、資源不足、狀態卡住、程式碼與容器不同步。
  · 絕不為了讓檢查通過而放寬安全控制（網段隔離、政策、Wazuh 規則、護欄）；
    這類失敗一律列為「需要人」，附上證據。
  · 不刪資料：不刪 volume、不 down -v、不 prune volume；磁碟清理只清 build cache 與無標籤映像。
  · 每個動作都記錄（指令、結束代碼、輸出摘要），可稽核。
只用 Python 標準函式庫；在專案根目錄執行（lab.sh 會先 cd 過去）。
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.getcwd()
RESULTS = os.path.join(ROOT, "results")
# 常駐服務（一次性的 seed、agent-* CLI 服務不在內）
EXPECTED = ["attacker-site", "grafana", "guard", "llm-proxy", "portal", "postgres", "runner-baseline",
            "runner-governed", "soar", "threatintel", "toolproxy", "victim", "websim",
            "wazuh.dashboard", "wazuh.indexer", "wazuh.manager"]
LOG_STREAMS = ["toolproxy-decisions", "agent-events", "sink-hits", "approvals", "actions",
               "soar-decisions", "guard-decisions", "llm-calls"]
# 各服務的「程式碼／設定來源」，比容器新就代表沒重建、沒套用
SOURCES = {"app": ["toolproxy", "guard", "llm-proxy", "portal", "soar", "runner-governed", "runner-baseline",
                   "websim", "victim", "attacker-site", "threatintel"],
           "config/wazuh_cluster": ["wazuh.manager"], "wiki": ["toolproxy"], "repo": ["toolproxy"],
           "grafana": ["grafana"]}
# 服務 log 裡的已知錯誤特徵 → 問題代碼
# (特徵, 問題代碼, 只看哪些服務；None＝全部)
LOG_SIGNATURES = [
    (r"max virtual memory areas vm\.max_map_count", "D02", None),
    (r"No space left on device", "D05", None),
    (r"address already in use", "D20", None),
    (r"(certificate|SSLHandshake|PKIX).{0,80}(fail|invalid|unknown|expired)", "D09",
     {"wazuh.indexer", "wazuh.dashboard", "wazuh.manager"}),
]
NET_SIGNATURES = r"TLS handshake timeout|i/o timeout|pull access denied|toomanyrequests|" \
                 r"Temporary failure in name resolution|no such host|connection reset by peer"

# 修法目錄：代碼 → (說明, 是否可自動, 對應問題)
FIXES = {
    "F01": ("啟動 Docker 服務（systemctl start docker）", True),
    "F02": ("設定 vm.max_map_count=262144 並寫入 /etc/sysctl.d 永久生效", True),
    "F03": ("起齊所有容器（./lab.sh up）", True),
    "F04": ("重啟反覆崩潰的服務（先保存 log；記憶體不足則需人調整 WSL 記憶體）", True),
    "F05": ("清理 Docker build cache 與無標籤映像（不刪 volume、不刪資料）", True),
    "F06": ("重建 wazuh.manager 容器讓設定與規則生效（--force-recreate）", True),
    "F07": ("等待 Wazuh indexer 就緒，逾時則重啟 indexer 一次", True),
    "F08": ("補建紀錄檔、工作佇列資料夾、筆記種子、憑證（./lab.sh ensure）", True),
    "F10": ("解除 SOAR 對 Agent 的撤銷（測試留下的狀態）", True),
    "F11": ("重啟執行器，清掉卡在 running 的工作", True),
    "F12": ("依新程式碼重建映像並重建容器（docker compose build＋up -d）", True),
    "F15": ("把新版 .env.example 才有的設定鍵補進 .env（不改既有值）", True),
    "F17": ("把資料庫唯讀帳號 agent_ro 的密碼同步成 .env 的值", True),
    "F18": ("把腳本的 CRLF 換行轉回 LF", True),
    "M13": ("模型服務連不上：在模型主機確認 Ollama 在線、OLLAMA_HOST=0.0.0.0、防火牆開 11434、模型已 pull、.env 的 LLM_UPSTREAM 正確", False),
    "M16": (".env 憑證仍是預設值：需重新安裝（./install.sh --fresh-env）並同步資料庫密碼，或由人決定", False),
    "M19": ("下載映像或套件時網路失敗：檢查 DNS、公司 Proxy、Docker Hub 速率限制；稍後重試 ./lab.sh up", False),
    "M20": ("連接埠被其他程式占用：用 ss -ltnp 找出程式，由人決定停用或改 .env 的埠號", False),
    "M21": ("安全檢查失敗（隔離／護欄／政策）：不可為了通過而放寬，需人檢查", False),
    "M04": ("容器記憶體不足（OOM）：需人調高 .wslconfig 的 memory 後 wsl --shutdown", False),
    "M09": ("憑證錯誤：確認主機時間正確；必要時由人刪除 config/wazuh_indexer_ssl_certs/* 後 ./lab.sh up 重新產生", False),
}
# 入口網站元件代碼 → compose 服務名稱
COMP2SVC = {"indexer": "wazuh.indexer", "manager": "wazuh.manager", "dashboard": "wazuh.dashboard",
            "attacker": "attacker-site", "runner_governed": "runner-governed", "runner_baseline": "runner-baseline",
            "llm_proxy": "llm-proxy"}
AUTO_ORDER = ["F01", "F18", "F02", "F05", "F15", "F08", "F12", "F03", "F06", "F07", "F17", "F10", "F11", "F04"]

actions: list[dict] = []


# ---------------------------------------------------------------- 工具
def run(cmd, timeout=120, check_log=True) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout,
                           shell=isinstance(cmd, str))
        return p.returncode, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired:
        return 124, f"逾時（{timeout}s）"
    except FileNotFoundError as e:
        return 127, str(e)


SECRET_ARG = re.compile(r"((?:PGPASSWORD|NEWPW|PASSWORD|TOKEN|PIN)=)\S+", re.I)


def masked(cmd) -> str:
    """紀錄與畫面上一律遮蔽密碼類參數（修復報告會被保存、也可能被自動化代理讀取）。"""
    return SECRET_ARG.sub(r"\1***", cmd if isinstance(cmd, str) else " ".join(cmd))


def act(fix: str, cmd, timeout=600) -> int:
    t0 = time.time()
    rc, out = run(cmd, timeout)
    actions.append({"fix": fix, "cmd": masked(cmd), "rc": rc,
                    "seconds": round(time.time() - t0, 1), "output_tail": SECRET_ARG.sub(r"\1***", out[-800:])})
    print(f"  [{fix}] rc={rc} {masked(cmd)}", flush=True)
    return rc


def env_file() -> dict:
    d = {}
    try:
        for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.rstrip("\n"))
            if m:
                d[m.group(1)] = m.group(2)
    except OSError:
        pass
    return d


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def newest_mtime(path: str) -> float:
    best = 0.0
    for dirpath, dirs, files in os.walk(os.path.join(ROOT, path)):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            try:
                best = max(best, os.path.getmtime(os.path.join(dirpath, f)))
            except OSError:
                pass
    return best


def container_created(service: str) -> float | None:
    rc, cid = run(["docker", "compose", "ps", "-q", service], 30)
    cid = cid.strip().splitlines()[0] if rc == 0 and cid.strip() else ""
    if not cid:
        return None
    rc, out = run(["docker", "inspect", "--format", "{{.Created}}", cid], 30)
    if rc != 0:
        return None
    s = out.strip()
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)", s)
    if not m:
        return None
    t = dt.datetime.fromisoformat(m.group(1) + (m.group(3).replace("Z", "+00:00")))
    return t.timestamp()


def container_started(service: str) -> str | None:
    rc, cid = run(["docker", "compose", "ps", "-q", service], 30)
    cid = cid.strip().splitlines()[0] if rc == 0 and cid.strip() else ""
    if not cid:
        return None
    rc, out = run(["docker", "inspect", "--format", "{{.State.StartedAt}}", cid], 30)
    return out.strip() if rc == 0 and out.strip() else None


def http_json(url: str, method="GET", body=None, headers=None, timeout=10):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": f"{type(e).__name__}: {e}"}


def logtest(line: str) -> str:
    rc, out = run(f"printf '%s\\n' '{line}' | docker compose exec -T wazuh.manager /var/ossec/bin/wazuh-logtest", 60)
    m = re.search(r"id: '(\d+)'", out)
    return m.group(1) if m else ""


# ---------------------------------------------------------------- 診斷
def diagnose(bundle: str | None = None) -> dict:
    issues: list[dict] = []
    facts: dict = {}

    def issue(iid, sev, title, fix, evidence):
        issues.append({"id": iid, "severity": sev, "title": title, "fix": fix,
                       "auto": FIXES.get(fix, ("", False))[1], "evidence": evidence})

    env = env_file()
    facts["env_keys"] = sorted(env)            # 只記鍵名，不記值
    rc, _ = run(["docker", "info"], 30)
    facts["docker_ok"] = rc == 0
    if rc != 0:
        issue("D01", "error", "Docker 服務沒有在跑", "F01", "docker info 失敗")
        return finish_diag(issues, facts, bundle)

    # CRLF
    crlf = [f for f in glob.glob("*.sh") + ["config/wazuh_integrations/custom-soar", "tools/agentlab_doctor.py"]
            if os.path.exists(f) and b"\r\n" in open(f, "rb").read()]
    if crlf:
        issue("D18", "error", "腳本是 CRLF 換行，Linux 會執行失敗", "F18", crlf)

    # 核心參數
    try:
        mmc = int(open("/proc/sys/vm/max_map_count").read().strip())
    except OSError:
        mmc = 0
    persisted = any("vm.max_map_count" in open(f).read() for f in
                    glob.glob("/etc/sysctl.d/*.conf") + ["/etc/sysctl.conf"] if os.path.exists(f))
    facts["vm.max_map_count"] = mmc
    if mmc < 262144 or not persisted:
        issue("D02", "error" if mmc < 262144 else "warn", "vm.max_map_count 不足或重開機後不會保留", "F02",
              {"current": mmc, "persisted": persisted})

    # 磁碟
    free_gb = shutil.disk_usage(ROOT).free / 1024 ** 3
    facts["disk_free_gb"] = round(free_gb, 1)
    if free_gb < 10:
        issue("D05", "error" if free_gb < 5 else "warn", "磁碟剩餘空間不足", "F05", f"剩 {free_gb:.1f} GB")

    # .env
    if not env:
        issue("D16", "error", "沒有 .env（尚未安裝或被刪）", "M16", "找不到 .env")
    else:
        example = {m.group(1) for line in open(".env.example", encoding="utf-8")
                   if (m := re.match(r"^([A-Z_][A-Z0-9_]*)=", line))}
        missing = sorted(example - set(env))
        if missing:
            issue("D15", "warn", ".env 缺少新版設定鍵", "F15", missing)
        weak = [k for k in ("AGENT_TOKEN_SOC01", "SOAR_ADMIN_TOKEN", "DB_RO_PASSWORD", "PORTAL_PIN")
                if not env.get(k) or env.get(k, "").startswith("change-me")]
        if weak:
            issue("D16", "error", ".env 的憑證仍是預設值或空白", "M16", weak)

    # 紀錄檔、種子、憑證
    missing_files = [f"logs/{s}.ndjson" for s in LOG_STREAMS if not os.path.exists(f"logs/{s}.ndjson")]
    missing_files += [p for p in ("logs/notes.json", "jobs/governed/pending", "jobs/baseline/pending")
                      if not os.path.exists(p)]
    if not glob.glob("config/wazuh_indexer_ssl_certs/*"):
        missing_files.append("config/wazuh_indexer_ssl_certs/*")
    if missing_files:
        issue("D08", "error", "紀錄檔、工作佇列、筆記種子或憑證缺漏", "F08", missing_files)

    # 容器狀態
    rc, out = run(["docker", "compose", "ps", "-a", "--format", "{{.Service}}\t{{.State}}\t{{.Status}}"], 60)
    states = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            states[parts[0]] = (parts[1], parts[2] if len(parts) > 2 else "")
    facts["services"] = {k: v[1] for k, v in states.items()}
    not_running = [s for s in EXPECTED if states.get(s, ("missing",))[0] != "running"]
    restarting = [s for s in EXPECTED if states.get(s, ("",))[0] == "restarting"
                  or "Restarting" in states.get(s, ("", ""))[1]]
    if not_running:
        issue("D03", "error", "有常駐服務沒有在跑", "F03",
              {s: states.get(s, ("不存在", ""))[1] or states.get(s, ("不存在",))[0] for s in not_running})
    oom = []
    for s in EXPECTED:
        rc, cid = run(["docker", "compose", "ps", "-a", "-q", s], 20)
        if cid.strip():
            rc, o = run(["docker", "inspect", "--format", "{{.State.OOMKilled}} {{.RestartCount}}",
                         cid.strip().splitlines()[0]], 20)
            if o.startswith("true"):
                oom.append(s)
            elif len(o.split()) > 1 and o.split()[1].isdigit() and int(o.split()[1]) >= 3 and s not in restarting:
                restarting.append(s)
    if oom:
        issue("D04", "error", "容器因記憶體不足被終止（OOM）", "M04", oom)
    if restarting:
        issue("D04", "error", "服務反覆重啟（崩潰迴圈）", "F04", restarting)

    # log 特徵掃描（同時存進診斷包）
    sig_hits: dict = {}
    for s in EXPECTED:
        rc, o = run(["docker", "compose", "logs", "--no-color", "--tail=300", s], 60)
        if bundle:
            with open(os.path.join(bundle, "logs", f"{s}.log"), "w", encoding="utf-8") as f:
                f.write(o)
        # 特徵比對只看「這次容器啟動之後」的 log：restart 不會清掉舊 log，修好後才不會一直誤判
        started = container_started(s)
        if started:
            rc, o = run(["docker", "compose", "logs", "--no-color", "--since", started, s], 60)
        for pat, iid, only in LOG_SIGNATURES:
            if (only is None or s in only) and re.search(pat, o, re.I):
                sig_hits.setdefault(iid, []).append(s)
    for iid, svcs in sig_hits.items():
        fix = {"D02": "F02", "D05": "F05", "D20": "M20", "D09": "M09"}[iid]
        title = {"D02": "服務 log 顯示 vm.max_map_count 不足", "D05": "服務 log 顯示磁碟已滿",
                 "D20": "連接埠被占用", "D09": "Wazuh 元件憑證錯誤"}[iid]
        if not any(i["id"] == iid for i in issues):
            issue(iid, "error", title, fix, {"services": svcs})
    inst = ""
    if os.path.exists("results/install-latest.log"):
        inst = open("results/install-latest.log", encoding="utf-8", errors="replace").read()[-20000:]
    if re.search(NET_SIGNATURES, inst, re.I):
        issue("D19", "error", "安裝紀錄顯示下載映像或套件時網路失敗", "M19",
              re.findall(NET_SIGNATURES, inst, re.I)[:5])

    # 資料庫唯讀帳號：由實際使用者（治理閘道）用它自己的連線字串登入。
    # 官方 postgres 映像對 127.0.0.1 是 trust，從 postgres 容器內測不出密碼錯，所以從 toolproxy 測。
    if states.get("postgres", ("",))[0] == "running" and states.get("toolproxy", ("",))[0] == "running":
        rc, o = run(["docker", "compose", "exec", "-T", "toolproxy", "python", "-c",
                     "import os,psycopg; psycopg.connect(os.environ['DB_RO_DSN'], connect_timeout=5).close(); print('ok')"], 40)
        facts["db_agent_ro_login"] = rc == 0
        if rc != 0 and "password authentication failed" in o:
            issue("D17", "error", "資料庫唯讀帳號 agent_ro 的密碼與 .env 不一致（治理閘道查不了資料庫）", "F17",
                  "用 .env 的 DB_RO_PASSWORD 登入失敗")

    # 程式碼／設定比容器新（改了沒重建）
    stale_app, stale_mgr = [], False
    for src, svcs in SOURCES.items():
        mt = newest_mtime(src)
        for s in svcs:
            c = container_created(s)
            if c and mt > c + 2:
                if s == "wazuh.manager":
                    stale_mgr = True
                elif s not in stale_app:
                    stale_app.append(s)
    if stale_app:
        issue("D12", "warn", "程式碼比容器新（改過但沒重建）", "F12", stale_app)
    if stale_mgr:
        issue("D06", "error", "Wazuh 設定或規則比 manager 容器新（沒生效）", "F06", "config/wazuh_cluster")

    # Wazuh indexer、規則
    if states.get("wazuh.indexer", ("",))[0] == "running":
        rc, o = run(["docker", "compose", "exec", "-T", "wazuh.indexer", "curl", "-sk", "-u", "admin:SecretPassword",
                     "https://localhost:9200/_cluster/health"], 30)
        facts["indexer_health"] = (re.search(r'"status"\s*:\s*"(\w+)"', o) or [None, "down"])[1]
        if facts["indexer_health"] not in ("green", "yellow"):
            issue("D07", "error", "Wazuh indexer 尚未就緒", "F07", facts["indexer_health"])
    if states.get("wazuh.manager", ("",))[0] == "running" and not stale_mgr:
        samples = {
            "100901": '{"trace_id":"d","agent_id":"d","tool":"x","decision":"deny","reason":"d"}',
            "100909": '{"trace_id":"d","agent_id":"d","stage":"tool_result","direction":"in","tool":"fetch_web","guard_decision":"redact","categories":"injection"}',
            "100910": '{"trace_id":"d","agent_id":"d","stage":"tool_args","direction":"out","tool":"x","guard_decision":"block","categories":"dlp"}',
            "100913": '{"trace_id":"d","agent_id":"d","stage":"answer","direction":"out","tool":"","guard_decision":"redact","categories":"exfil_url"}',
        }
        got = {k: logtest(v) for k, v in samples.items()}
        facts["rules_logtest"] = got
        if any(got[k] != k for k in got):
            issue("D06", "error", "Wazuh 自訂規則沒有正確載入", "F06", got)

    # 撤銷狀態、卡住的工作
    try:
        revoked = json.load(open("logs/revocations.json")).get("revoked", [])
    except Exception:  # noqa: BLE001
        revoked = []
    if revoked:
        issue("D10", "warn", "有 Agent 的憑證被 SOAR 撤銷中（多半是測試留下的）", "F10", revoked)
    stuck = [p for p in glob.glob("jobs/*/running/*.json") if time.time() - os.path.getmtime(p) > 900]
    if stuck:
        issue("D11", "warn", "有工作卡在 running 超過 15 分鐘", "F11", stuck)

    # 入口網站與模型
    port = env.get("PORTAL_PORT", "8080") or "8080"
    st, s = http_json(f"http://localhost:{port}/api/status")
    facts["portal_http"] = st
    if st == 200:
        gov = s.get("runners", {}).get("governed", {})
        facts["model_ok"] = bool(gov.get("model_ok"))
        if not gov.get("model_ok"):
            issue("D13", "warn", "受治理 Agent 連不到模型服務", "M13",
                  {"detail": gov.get("detail"), "LLM_UPSTREAM": env.get("LLM_UPSTREAM", "")})
        bad = {k: v.get("detail") for k, v in s.get("components", {}).items()
               if not v.get("ok") and k not in ("model", "llm_proxy")}
        if bad and not not_running:
            issue("D14", "warn", "入口網站回報有元件不健康", "F04", bad)
    elif "portal" not in not_running:
        issue("D14", "error", f"入口網站沒有回應（HTTP {st}）", "F04", s.get("error", ""))

    # 安全控制的驗收結果（只讀；失敗不自動修）
    if os.path.exists("results/verify-latest.json"):
        try:
            v = json.load(open("results/verify-latest.json", encoding="utf-8"))
            sec = [c["id"] for c in v.get("checks", []) if c["id"] in ("C05", "C07", "C08", "C09", "C10", "C14", "C15", "B10", "B11")
                   and c["result"] == "fail"]
            if sec:
                issue("D21", "error", "上次驗收有安全控制項目未通過", "M21", sec)
        except Exception:  # noqa: BLE001
            pass

    return finish_diag(issues, facts, bundle)


def finish_diag(issues, facts, bundle) -> dict:
    rep = {"generated": iso(time.time()), "host": os.uname().nodename,
           "overall": "OK" if not [i for i in issues if i["severity"] == "error"] else "PROBLEMS",
           "issues": issues, "facts": facts,
           "auto_fixable": sorted({i["fix"] for i in issues if i["auto"]}, key=AUTO_ORDER.index),
           "needs_human": sorted({i["fix"] for i in issues if not i["auto"]})}
    os.makedirs(RESULTS, exist_ok=True)
    if bundle:
        with open(os.path.join(bundle, "summary.json"), "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=2)
    with open(os.path.join(RESULTS, "diagnose-latest.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2)
    return rep


def print_diag(rep: dict) -> None:
    print(f"\n診斷結果：{rep['overall']}（{rep['generated']}）")
    for i in rep["issues"]:
        mark = "自動" if i["auto"] else "需人"
        print(f"  [{i['severity'].upper():5}] {i['id']} {i['title']}  → {i['fix']}（{mark}）")
    if not rep["issues"]:
        print("  沒有發現已知問題。")
    print(f"可自動修：{', '.join(rep['auto_fixable']) or '無'}　需要人：{', '.join(rep['needs_human']) or '無'}")
    print("報告：results/diagnose-latest.json")


# ---------------------------------------------------------------- 修復
def wait_indexer(seconds: int) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        rc, o = run(["docker", "compose", "exec", "-T", "wazuh.indexer", "curl", "-sk", "-u", "admin:SecretPassword",
                     "https://localhost:9200/_cluster/health"], 20)
        if re.search(r'"status"\s*:\s*"(green|yellow)"', o):
            return True
        time.sleep(10)
    return False


def evidence_for(fix: str, rep: dict) -> list:
    """同一個修法可能對應多個問題，把證據裡的服務名稱合併起來。"""
    out: list = []
    for i in rep["issues"]:
        if i["fix"] != fix:
            continue
        ev = i.get("evidence")
        items = ev if isinstance(ev, list) else list(ev) if isinstance(ev, dict) else []
        for x in items:
            x = COMP2SVC.get(x, x)
            if x not in out:
                out.append(x)
    return out


def apply_fix(fix: str, rep: dict) -> None:
    if fix == "F01":
        act(fix, ["systemctl", "start", "docker"], 120)
        for _ in range(20):
            if run(["docker", "info"], 20)[0] == 0:
                break
            time.sleep(3)
    elif fix == "F02":
        act(fix, ["sysctl", "-w", "vm.max_map_count=262144"], 30)
        act(fix, "echo 'vm.max_map_count=262144' > /etc/sysctl.d/99-agentlab.conf", 30)
        # indexer 是在值不足時啟動的：要重啟它才會套用新值，log 裡的開機警告也才會消失
        if run(["docker", "compose", "ps", "-q", "wazuh.indexer"], 20)[1].strip():
            act(fix, ["docker", "compose", "restart", "wazuh.indexer"], 300)
            ok = wait_indexer(240)
            actions.append({"fix": fix, "cmd": "等待 indexer 重啟後就緒", "rc": 0 if ok else 1, "seconds": 0,
                            "output_tail": "就緒" if ok else "仍未就緒"})
    elif fix == "F03":
        act(fix, ["./lab.sh", "up"], 1800)
    elif fix == "F04":
        svcs = [s for s in evidence_for("F04", rep) if s in EXPECTED] or ["portal"]
        act(fix, ["docker", "compose", "restart", *svcs], 300)
    elif fix == "F05":
        act(fix, ["docker", "builder", "prune", "-f"], 600)
        act(fix, ["docker", "image", "prune", "-f"], 600)
    elif fix == "F06":
        act(fix, ["docker", "compose", "up", "-d", "--force-recreate", "wazuh.manager"], 600)
        time.sleep(20)
    elif fix == "F07":
        if not wait_indexer(300):
            act(fix, ["docker", "compose", "restart", "wazuh.indexer"], 300)
            ok = wait_indexer(240)
            actions.append({"fix": fix, "cmd": "wait indexer", "rc": 0 if ok else 1, "seconds": 0,
                            "output_tail": "就緒" if ok else "仍未就緒"})
    elif fix == "F08":
        act(fix, ["./lab.sh", "ensure"], 900)
    elif fix == "F10":
        # 入口網站 /api/reset 即使個別 Agent 解除失敗也回 HTTP 200，要看內容的 ok；
        # 同一輪若剛重啟過治理閘道（例如 F17），閘道可能還沒起來，所以重試到全部成功（最多約 90 秒）。
        env = env_file()
        port = env.get("PORTAL_PORT", "8080") or "8080"
        ok_all, last = False, ""
        for attempt in range(1, 10):
            st, body = http_json(f"http://localhost:{port}/api/reset", "POST", {},
                                 {"X-Portal-Pin": env.get("PORTAL_PIN", "")})
            results = body.get("unrevoked", []) if isinstance(body, dict) else []
            ok_all = st == 200 and all(r.get("ok") for r in results)
            last = f"HTTP {st} {results}"
            if ok_all:
                break
            time.sleep(10)
        actions.append({"fix": fix, "cmd": "POST /api/reset（解除撤銷）", "rc": 0 if ok_all else 1,
                        "seconds": 0, "output_tail": f"第 {attempt} 次：{last}"[:800]})
        print(f"  [F10] 解除撤銷 {'成功' if ok_all else '失敗'}（第 {attempt} 次）", flush=True)
    elif fix == "F11":
        act(fix, ["docker", "compose", "restart", "runner-governed", "runner-baseline"], 300)
    elif fix == "F12":
        act(fix, ["docker", "compose", "build"], 1800)
        act(fix, ["docker", "compose", "up", "-d"], 900)
    elif fix == "F15":
        env = env_file()
        added = []
        with open(".env", "a", encoding="utf-8") as out:
            for line in open(".env.example", encoding="utf-8"):
                m = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
                if m and m.group(1) not in env:
                    out.write(line if line.endswith("\n") else line + "\n")
                    added.append(m.group(1))
        actions.append({"fix": fix, "cmd": "合併 .env.example 新鍵", "rc": 0, "seconds": 0,
                        "output_tail": ", ".join(added)})
        print(f"  [F15] 補上：{', '.join(added) or '無'}", flush=True)
        act(fix, ["docker", "compose", "up", "-d"], 900)
    elif fix == "F17":
        # 以 .env 的值為準（容器環境變數可能是舊的）；值由安裝器以十六進位亂數產生，不含引號
        pw = env_file().get("DB_RO_PASSWORD", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", pw or ""):
            actions.append({"fix": fix, "cmd": "檢查 DB_RO_PASSWORD 格式", "rc": 1, "seconds": 0,
                            "output_tail": "密碼含特殊字元，不自動處理"})
            return
        act(fix, ["docker", "compose", "exec", "-T", "-e", f"NEWPW={pw}", "postgres", "sh", "-c",
                  "psql -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" "
                  "-c \"ALTER ROLE agent_ro PASSWORD '$NEWPW'\""], 120)
        act(fix, ["docker", "compose", "up", "-d", "toolproxy"], 300)
        act(fix, ["docker", "compose", "restart", "toolproxy"], 120)
    elif fix == "F18":
        act(fix, "sed -i 's/\\r$//' ./*.sh config/wazuh_integrations/custom-soar tools/*.py && "
                 "chmod +x ./*.sh config/wazuh_integrations/custom-soar tools/*.py", 60)


def repair(target: str, max_rounds: int = 3) -> int:
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    rounds = []
    if target not in ("auto",) and target not in FIXES:
        print(f"沒有這個修法：{target}。可用：{', '.join(FIXES)}")
        return 2
    if target != "auto" and not FIXES[target][1]:
        print(f"{target} 需要人處理：{FIXES[target][0]}")
        return 2
    before = diagnose()
    rep = before
    tried: dict = {}          # 修法 → 套用前存在的問題代碼
    ineffective: list = []
    for r in range(1, (max_rounds if target == "auto" else 1) + 1):
        current = {i["fix"]: {j["id"] for j in rep["issues"] if j["fix"] == i["fix"]} for i in rep["issues"]}
        for fx, ids in tried.items():
            if fx in current and current[fx] & ids and fx not in ineffective:
                ineffective.append(fx)
        todo = [f for f in (rep["auto_fixable"] if target == "auto" else [target]) if f not in ineffective]
        if not todo:
            break
        for fx in todo:
            tried[fx] = current.get(fx, set())
        print(f"\n第 {r} 輪修復：{', '.join(todo)}")
        n0 = len(actions)
        for fx in todo:
            apply_fix(fx, rep)
        rounds.append({"round": r, "fixes": todo, "actions": actions[n0:]})
        time.sleep(15)
        rep = diagnose()
        if target != "auto":
            break
    after = rep
    out = {"generated": iso(time.time()), "target": target,
           "before": [f"{i['id']}:{i['fix']}" for i in before["issues"]],
           "after": [f"{i['id']}:{i['fix']}" for i in after["issues"]],
           "rounds": rounds, "result": after["overall"],
           "ineffective_fixes": [{"fix": f, "what": FIXES[f][0],
                                  "issues": [i["id"] for i in after["issues"] if i["fix"] == f]} for f in ineffective
                                 if any(i["fix"] == f for i in after["issues"])],
           "needs_human": sorted(set(after["needs_human"]) | {f for f in ineffective
                                                              if any(i["fix"] == f for i in after["issues"])}),
           "remaining_auto": [f for f in after["auto_fixable"] if f not in ineffective]}
    for p in (os.path.join(RESULTS, f"repair-{stamp}.json"), os.path.join(RESULTS, "repair-latest.json")):
        with open(p, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
    print_diag(after)
    for x in out["ineffective_fixes"]:
        print(f"  ！{x['fix']} 套用後問題仍在（{', '.join(x['issues'])}）→ 不再重試，需要人或換方法")
    print(f"修復紀錄：results/repair-{stamp}.json（同時寫入 results/repair-latest.json）")
    if after["overall"] == "OK":
        return 0
    return 1


def main() -> int:
    args = sys.argv[1:] or ["diagnose"]
    if args[0] == "diagnose":
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        bundle = os.path.join(RESULTS, f"diagnose-{stamp}")
        os.makedirs(os.path.join(bundle, "logs"), exist_ok=True)
        # 附帶系統資訊（不含秘密）
        for name, cmd in {"docker-ps.txt": "docker compose ps -a", "disk.txt": "df -h / . && docker system df",
                          "memory.txt": "free -m", "listen.txt": "ss -ltnp 2>/dev/null | head -50",
                          "versions.txt": "docker version; docker compose version; uname -a"}.items():
            with open(os.path.join(bundle, name), "w", encoding="utf-8") as f:
                f.write(run(cmd, 60)[1])
        rep = diagnose(bundle)
        print_diag(rep)
        print(f"診斷包：{os.path.relpath(bundle)}（含各服務最近 300 行 log）")
        return 0 if rep["overall"] == "OK" else 1
    if args[0] == "repair":
        tgt = args[1] if len(args) > 1 else "auto"
        if tgt == "list":
            for k, (d, a) in FIXES.items():
                print(f"  {k}  {'自動' if a else '需人'}  {d}")
            return 0
        return repair(tgt)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
