#!/usr/bin/env bash
set -euo pipefail

# Apply the repository ruleset stored in .github/branch-protection.json.
# Creates the ruleset when it is missing and updates it by name otherwise.
# Requires an authenticated GitHub CLI with admin access to the repository.
#
# Usage: scripts/apply-branch-protection.sh [owner/repo]

script_dir="$(dirname -- "$(readlink -f -- "$0")")"
config="${script_dir}/../.github/branch-protection.json"
repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
name="$(node -p "require(process.argv[1]).name" "$config")"

ruleset_id="$(
  gh api "repos/${repo}/rulesets" \
    --jq ".[] | select(.name == \"${name}\") | .id" || true
)"

if [[ -n "${ruleset_id}" ]]; then
  gh api --method PUT "repos/${repo}/rulesets/${ruleset_id}" --input "$config"
else
  gh api --method POST "repos/${repo}/rulesets" --input "$config"
fi
