#!/usr/bin/env bash
# 全部資料源跑一輪並重建網頁。
# 單一來源失敗不中斷（保留上一輪的 data/*.json），最後回報哪幾支掛了。
set -uo pipefail
cd "$(dirname "$0")"

HTTP_FETCHERS=(showtimes ambassador centuryasia miranew lux arthouse atmovies)
BROWSER_FETCHERS=(skcinemas in89)   # 需要 playwright，較慢，序列跑避免同時開太多瀏覽器

failed=()

run() {
  local name=$1
  printf '\n=== %s ===\n' "$name"
  if ! node "fetch/$name.mjs"; then
    echo "!! $name 失敗（沿用上一輪資料）"
    failed+=("$name")
  fi
}

# 純 HTTP 的可以平行，但各家站台都不大，序列跑比較禮貌也好除錯
for f in "${HTTP_FETCHERS[@]}"; do run "$f"; done
for f in "${BROWSER_FETCHERS[@]}"; do run "$f"; done

run movie_meta

printf '\n=== build ===\n'
node build_site.mjs || { echo "!! build_site 失敗"; exit 1; }

if ((${#failed[@]})); then
  printf '\n完成，但這幾支失敗：%s\n' "${failed[*]}"
  exit 1
fi
printf '\n全部完成。\n'
