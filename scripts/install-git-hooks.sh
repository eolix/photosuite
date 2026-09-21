#!/bin/sh
# Installs repo git hooks (pre-commit runs verify + test).
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"
cat > "$HOOK" <<'EOF'
#!/bin/sh
set -e
cd "$(git rev-parse --show-toplevel)"
npm run verify
npm test
EOF
chmod +x "$HOOK"
echo "Installed $HOOK"
