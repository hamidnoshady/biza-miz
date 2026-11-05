#!/usr/bin/env bash
set +e
npm run build 2>&1 | tee .next-build-ci.log
build_exit_code=${PIPESTATUS[0]}
if [[ $build_exit_code -ne 0 ]]; then
  echo '::group::Next.js production build diagnostics'
  diagnostics=$(grep -Ei 'error|fatal|out of memory|heap|exception|killed|failed' .next-build-ci.log | tail -n 120 || true)
  if [[ -n $diagnostics ]]; then
    printf '%s\n' "$diagnostics" | sed 's/^/::error::NEXT_BUILD: /'
  else
    tail -n 100 .next-build-ci.log | sed 's/^/::error::NEXT_BUILD: /'
  fi
  echo '::endgroup::'
  exit "$build_exit_code"
fi
