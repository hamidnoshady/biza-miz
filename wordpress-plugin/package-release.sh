#!/usr/bin/env bash
#
# Build the release asset the plugin's self-updater prefers
# (includes/class-pos-updater.php, POS_Connector_Updater::ASSET_NAME):
# a zip whose root is pos-accounting-connector/, so WordPress installs it
# as-is — no source-directory fixing, no downloading the whole repository.
#
# Full release runbook: docs/deployment/wordpress-plugin-updates.md

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v zip >/dev/null 2>&1; then
	echo "zip(1) is required (Debian/Ubuntu: apt install zip, macOS: built in)." >&2
	exit 1
fi

zipfile="pos-accounting-connector.zip"
rm -f "$zipfile"
zip -r "$zipfile" pos-accounting-connector
echo ""
echo "Built $zipfile — attach it to the GitHub release of the new tag."
