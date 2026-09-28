#!/bin/sh
# Роли как в проде: владелец схемы (миграции) и приложение (урезанные права, см. packages/db/src/grants.ts).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE stories_owner LOGIN PASSWORD '${STORIES_OWNER_PASSWORD}';
CREATE ROLE stories_app LOGIN PASSWORD '${STORIES_APP_PASSWORD}';
CREATE DATABASE stories OWNER stories_owner;
REVOKE ALL ON DATABASE stories FROM PUBLIC;
GRANT CONNECT ON DATABASE stories TO stories_app;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname stories <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO stories_owner;
SQL
