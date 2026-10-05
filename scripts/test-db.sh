#!/usr/bin/env bash
# Creates a scratch database, applies the Supabase shim + all migrations, then
# runs the SQL security/workflow test suite. Requires a local PostgreSQL 15+.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-csqa_test}
PSQL="sudo -u postgres psql -v ON_ERROR_STOP=1 -q -t -A"
sudo -u postgres dropdb --if-exists "$DB"
sudo -u postgres createdb "$DB"
$PSQL -d "$DB" -f supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do
  echo "applying $f"
  $PSQL -d "$DB" -f "$f"
done
$PSQL -d "$DB" -c "grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;"
echo "running tests"
for t in supabase/tests/[1-9]*.sql; do echo "test $t"; $PSQL -d "$DB" -f "$t"; done
echo "ALL SQL TESTS PASSED"
