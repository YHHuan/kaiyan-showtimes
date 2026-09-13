#!/usr/bin/env bash
set -euo pipefail
task_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_cache="$task_repo/.cache/local-skcinemas"
mkdir -p -- "$task_cache"
exec 9>"$task_cache/task.lock"
flock -n 9 || exit 0
if [[ -f "$task_cache/task.log" ]] && (( $(stat -c %s "$task_cache/task.log") > 262144 )); then
  mv -- "$task_cache/task.log" "$task_cache/task.previous.log"
fi
exec >>"$task_cache/task.log" 2>&1
printf '\n[%s] 本機新光補抓開始\n' "$(date --iso-8601=seconds)"
cd -- "$task_repo"
if [[ $(git branch --show-current) != main ]] || [[ -n $(git status --porcelain --untracked-files=all -- lib scripts) ]]; then
  echo '安全停止：本機不在 main，或補抓程式尚有未提交變更；不自動 pull 或執行其他分支'
  exit 1
fi
task_node=${KAIYAN_NODE_BIN:-${HOME}/.local/bin/node}
if [[ ! -x "$task_node" ]]; then task_node=$(command -v node); fi
"$task_node" scripts/publish-local-skcinemas.mjs --publish --if-due
printf '[%s] 本機新光補抓結束\n' "$(date --iso-8601=seconds)"
