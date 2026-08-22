#!/usr/bin/env bash
# 全部資料源跑一輪並重建網頁。
# 單一來源失敗不中斷（保留上一輪的 data/*.json），最後回報哪幾支掛了。
set -uo pipefail
cd "$(dirname "$0")"

# atmovies 必須排在 skcinemas 之後：它會看 _status.json 決定要不要啟用新光的備援，
# 跑在前面就只看得到上一輪的狀態，這一輪新光掛掉也不會補。
HTTP_FETCHERS=(showtimes ambassador centuryasia miranew lux arthouse arthouse2 prices cinemas geocode_fill)
BROWSER_FETCHERS=(skcinemas in89)   # 需要 playwright，較慢，序列跑避免同時開太多瀏覽器
LAST_FETCHERS=(atmovies)

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
for f in "${LAST_FETCHERS[@]}"; do run "$f"; done

run movie_meta

printf '\n=== build ===\n'
node build_site.mjs || { echo "!! build_site 失敗"; exit 1; }

if ((${#failed[@]})); then
  printf '\n完成，但這幾支失敗：%s\n' "${failed[*]}"
  exit 1
fi
printf '\n全部完成。\n'
