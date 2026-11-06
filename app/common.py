"""共用函式：事件紀錄。

每一筆紀錄同時寫到兩個地方：
1. 本機檔案 /logs/<類別>.ndjson（一行一筆 JSON，自動測試以此判定結果，最可靠）
2. Elasticsearch 的同名 index（給 Kibana 看；連不上時只警告、不中斷程式）
"""
import datetime
import json
import os
import threading

import httpx

LOG_DIR = os.getenv("LOG_DIR", "/logs")
ES_URL = os.getenv("ES_URL", "")  # 空字串＝這個元件不直接寫遙測（Wazuh 版靠 Wazuh 讀本機檔）

# 查詢型資料庫（weblogs）所在：ELK 版是 Elasticsearch，Wazuh 版是 Wazuh indexer（OpenSearch, https+帳密）。
# seed.py 載入 weblogs、toolproxy 的 search_logs 都走這裡。與遙測的 ES_URL 分開設定。
INDEXER_URL = os.getenv("INDEXER_URL", "") or ES_URL
INDEXER_USER = os.getenv("INDEXER_USER", "")
INDEXER_PASS = os.getenv("INDEXER_PASS", "")
INDEXER_VERIFY = os.getenv("INDEXER_VERIFY", "true").lower() not in ("0", "false", "no")

_lock = threading.Lock()
_warned = False


def indexer_request(method: str, path: str, **kw):
    """對 weblogs 資料庫發一個請求（自動帶帳密與 TLS 設定）。path 以 / 開頭。"""
    auth = (INDEXER_USER, INDEXER_PASS) if INDEXER_USER else None
    kw.setdefault("timeout", 15)
    return httpx.request(method, f"{INDEXER_URL}{path}", auth=auth, verify=INDEXER_VERIFY, **kw)


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def es_post(es_url: str, index: str, doc: dict) -> None:
    """盡力寫入 Elasticsearch；失敗只提示一次。"""
    global _warned
    if not es_url:
        return
    try:
        r = httpx.post(f"{es_url}/{index}/_doc", json=doc, timeout=10)
        if r.status_code >= 300 and not _warned:
            print(f"[warn] Elasticsearch 拒收紀錄（{r.status_code}）：{r.text[:200]}", flush=True)
            _warned = True
    except Exception as e:  # noqa: BLE001
        if not _warned:
            print(f"[warn] 無法寫入 Elasticsearch（{e}）；紀錄仍保存在 {LOG_DIR}", flush=True)
            _warned = True


def log_event(stream: str, event: dict, es_url: str | None = None) -> dict:
    """stream：紀錄類別，也是檔名與 ES index 名稱（須小寫），例如 agent-events。"""
    doc = {"@timestamp": now_iso(), **event}
    os.makedirs(LOG_DIR, exist_ok=True)
    with _lock:
        with open(os.path.join(LOG_DIR, f"{stream}.ndjson"), "a", encoding="utf-8") as f:
            f.write(json.dumps(doc, ensure_ascii=False) + "\n")
    es_post(ES_URL if es_url is None else es_url, stream, doc)
    return doc


def read_events(stream: str, trace_id: str | None = None) -> list[dict]:
    """讀回某類別的紀錄；給 trace_id 時只回傳同一次任務的紀錄。"""
    path = os.path.join(LOG_DIR, f"{stream}.ndjson")
    out: list[dict] = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if trace_id is None or d.get("trace_id") == trace_id:
                out.append(d)
    return out
