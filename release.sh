#!/bin/zsh
# Publishes a new Nerdledger release on GitHub.
#
# Usage:
#   ./release.sh            bump the patch version (0.3.0 -> 0.3.1)
#   ./release.sh minor      0.3.1 -> 0.4.0
#   ./release.sh major      0.4.0 -> 1.0.0
#   ./release.sh 1.2.3      set an exact version (or the one already in the manifest, to release it as it is)
#
# Steps: checks the tree is clean and tests pass, sets "version" in extension/manifest.json, zips the extension (a
# Nerdledger folder ready for "Load unpacked"), commits "Release vX.Y.Z", tags and pushes, and creates the GitHub
# release with the zip attached. Needs the GitHub CLI (`gh`) signed in and `npm install` done once.
set -euo pipefail
cd "${0:A:h}"

MANIFEST=extension/manifest.json
[ -z "$(git status --porcelain)" ] || { echo "error: commit or stash your changes first"; exit 1; }
current=$(plutil -extract version raw -o - "$MANIFEST")
IFS=. read -r ma mi pa <<< "$current"
case "${1:-patch}" in
  patch) version="$ma.$mi.$((pa + 1))" ;;
  minor) version="$ma.$((mi + 1)).0" ;;
  major) version="$((ma + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) version="$1" ;;
  *) echo "usage: ./release.sh [patch|minor|major|X.Y.Z]"; exit 1 ;;
esac
tag="v$version"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "error: $tag already exists"; exit 1; }
echo "Releasing $tag (was $current)"

results=$(npm test 2>&1) || { echo "$results" | tail -30; echo "error: tests failed"; exit 1; }
echo "$results" | grep -E "^ℹ (pass|fail)" | tr '\n' ' '; echo
previous=$(git describe --tags --abbrev=0 2>/dev/null || true)
sed -i '' -e "s/^  \"version\": \".*\"/  \"version\": \"$version\"/" "$MANIFEST"
[ "$(plutil -extract version raw -o - "$MANIFEST")" = "$version" ] || { echo "error: couldn't set the version"; exit 1; }

DIST="${TMPDIR:-/tmp}/nerdledger-dist"
rm -rf "$DIST" && mkdir -p "$DIST"
ditto extension "$DIST/Nerdledger"
find "$DIST" -name .DS_Store -delete
ZIP="$DIST/Nerdledger-$version.zip"
(cd "$DIST" && zip -qrX "$ZIP" Nerdledger)
sha=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)

git commit -q --allow-empty -am "Release $tag"   # empty when releasing the version already in the manifest
git tag -a "$tag" -m "Nerdledger $tag"
git push -q origin HEAD "$tag"

changes=$( [ -n "$previous" ] && git log --format='- %s' "$previous..$tag" | grep -v '^- Release v' || echo "- First release")
notes=$(cat <<NOTES
## Install

Download **Nerdledger-$version.zip** below and unzip it somewhere it can stay. Then, once:

1. Open \`arc://extensions\` in Arc (or \`chrome://extensions\` in Chrome, Brave, Edge...).
2. Turn on **Developer mode**, click **Load unpacked** and choose the **Nerdledger** folder.

To update later, replace the folder with the new one and click the reload arrow on Nerdledger's card.

## Changes

$changes

SHA-256: \`$sha\`
NOTES
)
gh release create "$tag" "$ZIP" --title "Nerdledger $tag" --notes "$notes"
echo "released $tag: $(gh release view "$tag" --json url --jq .url)"
