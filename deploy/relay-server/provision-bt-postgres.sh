#!/usr/bin/env bash
set -euo pipefail

PSQL=${PSQL:-/www/server/pgsql/bin/psql}
CREATEDB=${CREATEDB:-/www/server/pgsql/bin/createdb}
ENV_FILE=${ENV_FILE:-/etc/astergate-relay.env}
DB_NAME=${DB_NAME:-gpttool}
DB_USER=${DB_USER:-gpttool_app}
DB_PASSWORD=${DB_PASSWORD:-$(openssl rand -hex 24)}

test -x "$PSQL" || {
  echo "PostgreSQL is not installed by BaoTa at /www/server/pgsql" >&2
  exit 1
}

su - postgres -c "$PSQL -v ON_ERROR_STOP=1 -d postgres -c \"SET password_encryption='scram-sha-256'; ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASSWORD';\"" 2>/dev/null ||
  su - postgres -c "$PSQL -v ON_ERROR_STOP=1 -d postgres -c \"SET password_encryption='scram-sha-256'; CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';\""
su - postgres -c "$PSQL -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1 ||
  su - postgres -c "$CREATEDB -O $DB_USER $DB_NAME"
su - postgres -c "$PSQL -v ON_ERROR_STOP=1 -d postgres -c \"ALTER SYSTEM SET listen_addresses='127.0.0.1';\""
su - postgres -c "$PSQL -v ON_ERROR_STOP=1 -d postgres -c \"ALTER SYSTEM SET password_encryption='scram-sha-256';\""

temporary=$(mktemp "${ENV_FILE}.XXXXXX")
grep -v '^ASTERGATE_POSTGRES_' "$ENV_FILE" > "$temporary" || true
printf '%s\n' \
  'ASTERGATE_POSTGRES_HOST=127.0.0.1' \
  'ASTERGATE_POSTGRES_PORT=5432' \
  "ASTERGATE_POSTGRES_USER=$DB_USER" \
  "ASTERGATE_POSTGRES_PASSWORD=$DB_PASSWORD" \
  "ASTERGATE_POSTGRES_DATABASE=$DB_NAME" >> "$temporary"
chown root:astergate "$temporary"
chmod 0640 "$temporary"
mv "$temporary" "$ENV_FILE"

echo "PostgreSQL database is provisioned. Restart PostgreSQL after changing listen_addresses."
