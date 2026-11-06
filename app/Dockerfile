# 本實驗所有 Python 元件共用同一個映像檔：
# agent.py（AI Agent）、toolproxy.py（治理閘道 Proxy）、sink.py（受害主機／攻擊者網站／威脅情資）、
# seed.py（匯入假資料）、run_tests.py（自動測試）
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
