"""llmproxy.py — 模型代理（老師架構圖中 Agent → Ollama → LLM 那條線的管制點）

受治理 Agent 沒有對外網路，只能經由這裡連到模型服務（Ollama／vLLM，OpenAI 相容 API）。
這一版從單純轉送（nginx）改為有管制的代理：
  1. 模型白名單：只放行 LLM_ALLOWED_MODELS（預設＝.env 的 MODEL 與 GUARD_MODEL）。
     名稱帶 "cloud" 的模型一律拒絕——Ollama 的雲端模型會把提示送到 Ollama 的伺服器處理，
     等於敏感資料外送（鐵律一）。模型主機端仍應設 OLLAMA_NO_CLOUD=1，這裡是第二道檢查。
  2. 只開放 /v1/models 與 /v1/chat/completions；Ollama 原生 API（/api/pull、/api/delete…）一律不通。
  3. 每次呼叫記一筆 llm-calls（呼叫者、模型、放行/拒絕、字數、耗時），不記提示原文。
"""
from __future__ import annotations

import json
import os
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from common import log_event

UPSTREAM = os.getenv("LLM_UPSTREAM", "http://host.docker.internal:11434").rstrip("/")
TIMEOUT = float(os.getenv("LLM_TIMEOUT", "600"))


def allowed_models() -> set[str]:
    raw = os.getenv("LLM_ALLOWED_MODELS", "").strip()
    names = raw.split(",") if raw else [os.getenv("MODEL", ""), os.getenv("GUARD_MODEL", "")]
    return {n.strip() for n in names if n.strip()}


ALLOWED = allowed_models()
app = FastAPI(title="llm-proxy", docs_url=None, redoc_url=None)


def model_ok(model: str) -> tuple[bool, str]:
    if not model:
        return False, "沒有指定模型"
    if "cloud" in model.lower():
        return False, "雲端模型會把提示送出本機，禁止使用"
    if ALLOWED and model not in ALLOWED:
        return False, f"模型不在白名單（允許：{', '.join(sorted(ALLOWED))}）"
    return True, "通過"


def record(req: Request, model: str, decision: str, reason: str, status: int, t0: float,
           prompt_chars: int = 0, completion_chars: int = 0) -> None:
    log_event("llm-calls", {
        "trace_id": req.headers.get("x-trace-id", ""), "caller": req.headers.get("x-caller", "unknown"),
        "model": model, "llm_decision": decision, "reason": reason, "http_status": status,
        "prompt_chars": prompt_chars, "completion_chars": completion_chars,
        "latency_ms": int((time.time() - t0) * 1000)})


def fwd_headers(req: Request) -> dict:
    h = {"Content-Type": "application/json"}
    if req.headers.get("authorization"):
        h["Authorization"] = req.headers["authorization"]
    return h


@app.get("/v1/models")
def models(req: Request):
    try:
        r = httpx.get(f"{UPSTREAM}/v1/models", headers=fwd_headers(req), timeout=10)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"模型服務連不上：{type(e).__name__}"}, 502)
    if r.status_code >= 300:
        return Response(r.content, r.status_code, media_type="application/json")
    data = r.json()
    # 只列出白名單內的模型，Agent 不會知道還有哪些模型可用
    data["data"] = [m for m in data.get("data", []) if model_ok(str(m.get("id", "")))[0]]
    return data


@app.post("/v1/chat/completions")
async def chat(req: Request):
    t0 = time.time()
    try:
        body = await req.json()
    except (json.JSONDecodeError, ValueError):
        record(req, "", "deny", "請求不是 JSON", 400, t0)
        return JSONResponse({"error": "請求不是 JSON"}, 400)
    model = str(body.get("model", ""))
    ok, why = model_ok(model)
    prompt_chars = sum(len(str(m.get("content") or "")) for m in body.get("messages", []) if isinstance(m, dict))
    if not ok:
        record(req, model, "deny", why, 403, t0, prompt_chars)
        return JSONResponse({"error": {"message": f"llm-proxy 拒絕：{why}", "type": "model_not_allowed"}}, 403)
    body["stream"] = False   # 本環境的 Agent 與護欄都用非串流；統一關閉方便計數
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.post(f"{UPSTREAM}/v1/chat/completions", json=body, headers=fwd_headers(req))
    except Exception as e:  # noqa: BLE001
        record(req, model, "error", f"模型服務連不上：{type(e).__name__}", 502, t0, prompt_chars)
        return JSONResponse({"error": f"模型服務連不上：{type(e).__name__}"}, 502)
    completion_chars = 0
    try:
        msg = r.json()["choices"][0]["message"]
        completion_chars = len(msg.get("content") or "") + len(json.dumps(msg.get("tool_calls") or []))
    except Exception:  # noqa: BLE001
        pass
    record(req, model, "allow" if r.status_code < 300 else "error", f"HTTP {r.status_code}",
           r.status_code, t0, prompt_chars, completion_chars)
    return Response(r.content, r.status_code, media_type="application/json")


@app.get("/health")
def health():
    return {"ok": True, "upstream": UPSTREAM, "allowed": sorted(ALLOWED)}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def other(path: str, req: Request):
    t0 = time.time()
    record(req, "", "deny", f"不開放的路徑 /{path}", 404, t0)
    return JSONResponse({"error": f"llm-proxy 不開放 /{path}"}, 404)

