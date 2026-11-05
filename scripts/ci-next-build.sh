#!/usr/bin/env bash
set +e
npm run build 2>&1 | tee .next-build-ci.log
build_exit_code=${PIPESTATUS[0]}
if [[ $build_exit_code -ne 0 ]]; then
  echo '::group::Next.js production build diagnostics (last 180 lines)'
  tail -n 180 .next-build-ci.log | sed 's/^/::error::NEXT_BUILD: /'
  echo '::endgroup::'
  exit "$build_exit_code"
fi
