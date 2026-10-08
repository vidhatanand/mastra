#!/usr/bin/env bash
# Vibernt fan-out benchmark: runs one claimed batch of test files (repository paths, the arguments) with each package's
# own vitest, as upstream's per-package scripts do (turbo runs `vitest run` in the package directory). One vitest
# invocation per package in the batch; JUnit goes to .vibernt-junit/<package>.xml with the package path prefixed to the
# file names, so every case names its repository path. Extra vitest arguments: VITEST_ARGS.
set -uo pipefail
root=${GITHUB_WORKSPACE:-$PWD}
out="$root/.vibernt-junit"
rm -rf "$out"; mkdir -p "$out"
declare -A groups
order=()
for f in "$@"; do
  d=$(dirname "$f")
  while [ "$d" != "." ] && [ ! -f "$root/$d/package.json" ]; do d=$(dirname "$d"); done
  [ -z "${groups[$d]+x}" ] && order+=("$d")
  groups[$d]+=" ${f#"$d"/}"
done
rc=0
for d in "${order[@]}"; do
  name=$(printf '%s' "$d" | tr '/.' '__')
  echo "::group::vitest in $d:${groups[$d]}"
  # shellcheck disable=SC2086
  (cd "$root/$d" && pnpm exec vitest run ${groups[$d]} ${VITEST_ARGS:-} --reporter=default --reporter=junit --outputFile.junit="$out/$name.xml") || rc=$?
  echo "::endgroup::"
  if [ -f "$out/$name.xml" ] && [ "$d" != "." ]; then
    sed -i -e "s#classname=\"#classname=\"$d/#g" -e "s#<testsuite name=\"#<testsuite name=\"$d/#g" "$out/$name.xml"
  fi
done
exit $rc
