#!/usr/bin/env bash
# Smoke test: boots the dummy env + the forge entrypoint, then exercises REST, GraphQL,
# MCP, and real git clone/push against the local server.
set -u
cd "$(dirname "$0")/.."

ENV_URL="http://127.0.0.1:18080"
TOKEN="test-tok-12345"
LOG=$(mktemp)
PASS=0
FAIL=0

note()  { printf '%s\n' "$*"; }
pass()  { PASS=$((PASS+1)); printf 'PASS: %s\n' "$*"; }
fail()  { FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$*"; }

cleanup() {
  kill "$ENV_PID" "$MAIN_PID" 2>/dev/null
  wait 2>/dev/null
  rm -f "$LOG"
}
trap cleanup EXIT

python3 scripts/env_stub.py &
ENV_PID=$!
sleep 0.3

MAKEFUN_ENV_URL="$ENV_URL" MAKEFUN_SHOP_TOKEN="$TOKEN" node --experimental-strip-types main.ts >"$LOG" 2>&1 &
MAIN_PID=$!

# wait for the entry to register
for _ in $(seq 1 50); do
  if grep -q 'registered' "$LOG"; then break; fi
  sleep 0.1
done
grep -q 'registered' "$LOG" || { fail 'entry did not register'; cat "$LOG"; exit 1; }

PORT=$(sed -n 's/.*listening on port \([0-9]*\).*/\1/p' "$LOG" | head -1)
[ -n "$PORT" ] || { fail 'could not read ephemeral port'; cat "$LOG"; exit 1; }
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
note "forge listening at $BASE (dummy env at $ENV_URL)"

# --- REST ---
CODE=$(curl -s -o /tmp/gh_meta.json -w '%{http_code}' -H "$AUTH" "$BASE/api/v3/meta")
[ "$CODE" = "200" ] && grep -q installed_version /tmp/gh_meta.json && pass "GET /api/v3/meta -> 200" || fail "GET /api/v3/meta -> $CODE"

CODE=$(curl -s -o /tmp/gh_noauth.json -w '%{http_code}' "$BASE/api/v3/meta")
[ "$CODE" = "401" ] && pass "no token -> 401" || fail "no token -> $CODE"

CODE=$(curl -s -o /tmp/gh_repo.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"smokerepo","description":"smoke"}' "$BASE/api/v3/user/repos")
[ "$CODE" = "201" ] && pass "POST /api/v3/user/repos -> 201" || fail "POST /api/v3/user/repos -> $CODE"

CODE=$(curl -s -o /tmp/gh_readme.json -w '%{http_code}' -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"message":"add readme","content":"IyBzbW9rZQo="}' "$BASE/api/v3/repos/adaiversen/smokerepo/contents/README.md")
[ "$CODE" = "201" ] && pass "PUT contents/README.md -> 201" || fail "PUT contents/README.md -> $CODE"

CODE=$(curl -s -o /tmp/gh_readme_get.json -w '%{http_code}' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smokerepo/contents/README.md")
[ "$CODE" = "200" ] && grep -q 'IyBzbW9rZQo=' /tmp/gh_readme_get.json && pass "GET contents/README.md -> 200 base64" || fail "GET contents/README.md -> $CODE"

# malformed JSON
CODE=$(curl -s -o /tmp/gh_bad.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' -d 'not json' "$BASE/api/v3/user/repos")
[ "$CODE" = "400" ] && pass "malformed JSON -> 400" || fail "malformed JSON -> $CODE"

CODE=$(curl -s -o /tmp/gh_404.json -w '%{http_code}' -H "$AUTH" "$BASE/api/v3/nope")
[ "$CODE" = "404" ] && grep -q '"message"' /tmp/gh_404.json && pass "unknown route -> 404 JSON" || fail "unknown route -> $CODE"

# labels/issues
CODE=$(curl -s -o /tmp/gh_label.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"bug","color":"d73a4a"}' "$BASE/api/v3/repos/adaiversen/smokerepo/labels")
[ "$CODE" = "201" ] && pass "POST labels -> 201" || fail "POST labels -> $CODE"

CODE=$(curl -s -o /tmp/gh_issue.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"first issue","body":"hello","labels":["bug"]}' "$BASE/api/v3/repos/adaiversen/smokerepo/issues")
[ "$CODE" = "201" ] && pass "POST issues -> 201" || fail "POST issues -> $CODE"

# pull + merge
CODE=$(curl -s -o /tmp/gh_pull.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"pr1","head":"main","base":"main"}' "$BASE/api/v3/repos/adaiversen/smokerepo/pulls")
[ "$CODE" = "201" ] && pass "POST pulls -> 201" || fail "POST pulls -> $CODE"

# --- GraphQL ---
CODE=$(curl -s -o /tmp/gh_gql.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"query":"query { __type(name: \"Issue\") { kind name fields { name } } }"}' "$BASE/api/graphql")
[ "$CODE" = "200" ] && grep -q '"kind":"OBJECT"' /tmp/gh_gql.json && pass "GraphQL introspection Issue -> 200" || fail "GraphQL introspection -> $CODE"

# --- MCP ---
CODE=$(curl -s -o /tmp/gh_mcp.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE/mcp")
[ "$CODE" = "200" ] && grep -q '"protocolVersion"' /tmp/gh_mcp.json && pass "MCP initialize -> 200" || fail "MCP initialize -> $CODE"

CODE=$(curl -s -o /tmp/gh_mcp_tools.json -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$BASE/mcp")
[ "$CODE" = "200" ] && grep -q 'create_repo' /tmp/gh_mcp_tools.json && pass "MCP tools/list -> 200" || fail "MCP tools/list -> $CODE"

# --- git clone/push via the real git CLI ---
# use a fresh empty repo so the first push creates the branch
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"gitrepo"}' "$BASE/api/v3/user/repos")
[ "$CODE" = "201" ] && pass "create gitrepo for push -> 201" || fail "create gitrepo -> $CODE"

TMPD=$(mktemp -d)
export HOME_SAVED="$HOME"
export HOME="$TMPD"
git config --global user.name "moldys" 2>/dev/null
git config --global user.email "moldys@users.noreply.github.com" 2>/dev/null
git config --global "http.extraHeader" "Authorization: Bearer $TOKEN" 2>/dev/null

# create a local repo, add content, push to the forge
mkdir -p "$TMPD/seed"
cd "$TMPD/seed"
git init -q -b main
echo 'hello forge' > hello.txt
git add hello.txt
git commit -q -m 'seed commit'
if git push -q "$BASE/adaiversen/gitrepo.git" main:main 2>"$TMPD/push.err"; then
  pass "git push to forge -> ok"
else
  fail "git push to forge failed: $(cat "$TMPD/push.err")"
fi

# clone back
if git clone -q "$BASE/adaiversen/gitrepo.git" "$TMPD/clone" 2>"$TMPD/clone.err"; then
  if [ -f "$TMPD/clone/hello.txt" ] && [ "$(cat "$TMPD/clone/hello.txt")" = "hello forge" ]; then
    pass "git clone from forge -> content matches"
  else
    fail "git clone content mismatch"
  fi
else
  fail "git clone failed: $(cat "$TMPD/clone.err")"
fi

# non-fast-forward push must be rejected: push an orphan-root commit onto existing main
cd "$TMPD/seed"
git checkout -q --orphan fresh
echo 'orphan content' > other.txt
git add other.txt
git commit -q -m 'orphan commit'
if git push -q "$BASE/adaiversen/gitrepo.git" fresh:main 2>"$TMPD/nff.err"; then
  fail "non-fast-forward push was NOT rejected"
else
  if grep -q 'non-fast-forward' "$TMPD/nff.err"; then
    pass "non-fast-forward push rejected"
  else
    fail "non-fast-forward push rejected for wrong reason: $(cat "$TMPD/nff.err")"
  fi
fi

export HOME="$HOME_SAVED"
rm -rf "$TMPD"

note ""
note "smoke results: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
