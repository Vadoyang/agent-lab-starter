#!/bin/bash
# 建立 Agent 專用的唯讀帳號 agent_ro（受治理模式由 toolproxy 使用）。
# 只能讀 departments、employees_public、alerts；讀不到 employees（敏感欄位）與 service_accounts。
# （此檔由 postgres 映像檔在第一次初始化時自動執行；DB_RO_PASSWORD 來自 .env）

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE agent_ro LOGIN PASSWORD '${DB_RO_PASSWORD}';
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO agent_ro;
  GRANT USAGE ON SCHEMA public TO agent_ro;
  GRANT SELECT ON departments, employees_public, alerts TO agent_ro;
  ALTER ROLE agent_ro SET default_transaction_read_only = on;
EOSQL
