#!/usr/bin/env bash
# Creates a scratch database, applies the Supabase shim + all migrations, then
# runs the SQL security/workflow test suite. Requires a local PostgreSQL 15+.
#   Linux: runs as the `postgres` OS user via sudo.
#   macOS (Homebrew): needs a `postgres` superuser role; set PG_BIN / PGPORT if needed, e.g.
#     PG_BIN=/opt/homebrew/opt/postgresql@16/bin PGPORT=5433 npm run test:db
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-csqa_test}
BIN=${PG_BIN:+$PG_BIN/}
if [ "$(uname)" = "Linux" ]; then AS="sudo -u postgres"; U=""; else AS=""; U="-U postgres"; fi
PSQL="$AS ${BIN}psql $U -v ON_ERROR_STOP=1 -q -t -A"
$AS ${BIN}dropdb $U --if-exists "$DB"
$AS ${BIN}createdb $U "$DB"
$PSQL -d "$DB" -f supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do
  echo "applying $f"
  $PSQL -d "$DB" -f "$f"
done
$PSQL -d "$DB" -c "grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;"
echo "running tests"
for t in supabase/tests/[1-9]*.sql; do echo "test $t"; $PSQL -d "$DB" -f "$t"; done
echo "ALL SQL TESTS PASSED"
