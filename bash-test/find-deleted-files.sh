#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename -- "$0")"

print_usage() {
  cat <<EOF
用法: $SCRIPT_NAME [--all] <项目内目录>

列出指定目录及其所有子目录中，曾被 Git 删除的文件路径。
输出路径相对于 Git 仓库根目录，并进行去重和排序。

选项:
  --all       查询所有 refs 可达的历史；默认只查询当前分支历史
  -h, --help  显示帮助

示例:
  $SCRIPT_NAME apps/web/src
  $SCRIPT_NAME --all packages/db
EOF
}

fail() {
  printf '错误: %s\n' "$1" >&2
  exit 1
}

parse_arguments() {
  INCLUDE_ALL_REFS=false
  TARGET_DIRECTORY=""

  while (($# > 0)); do
    case "$1" in
      --all)
        INCLUDE_ALL_REFS=true
        ;;
      -h | --help)
        print_usage
        exit 0
        ;;
      --)
        shift
        (($# == 1)) || fail "-- 后必须且只能指定一个目录"
        TARGET_DIRECTORY="$1"
        break
        ;;
      -*)
        fail "未知选项: $1"
        ;;
      *)
        [[ -z "$TARGET_DIRECTORY" ]] || fail "只能指定一个目录"
        TARGET_DIRECTORY="$1"
        ;;
    esac
    shift
  done

  [[ -n "$TARGET_DIRECTORY" ]] || {
    print_usage >&2
    exit 2
  }
}

resolve_repository_directory() {
  local repository_root
  local requested_directory

  repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    fail "当前目录不在 Git 仓库中"
  REPOSITORY_ROOT="$(realpath -e -- "$repository_root")"
  requested_directory="$(realpath -m -- "$TARGET_DIRECTORY")"

  if [[ "$requested_directory" == "$REPOSITORY_ROOT" ]]; then
    REPOSITORY_DIRECTORY=""
  elif [[ "$requested_directory" == "$REPOSITORY_ROOT/"* ]]; then
    REPOSITORY_DIRECTORY="${requested_directory#"$REPOSITORY_ROOT/"}"
  else
    fail "目标目录必须位于当前 Git 仓库内: $TARGET_DIRECTORY"
  fi

  if [[ -e "$requested_directory" && ! -d "$requested_directory" ]]; then
    fail "目标路径不是目录: $TARGET_DIRECTORY"
  fi
}

list_deleted_files() {
  local -a history_scope=()
  local pathspec

  if [[ "$INCLUDE_ALL_REFS" == true ]]; then
    history_scope+=(--all)
  fi

  if [[ -n "$REPOSITORY_DIRECTORY" ]]; then
    pathspec=":(top,literal)$REPOSITORY_DIRECTORY"
  else
    pathspec=":(top)**"
  fi

  git -C "$REPOSITORY_ROOT" log \
    "${history_scope[@]}" \
    --diff-filter=D \
    --format= \
    --name-only \
    -z \
    -- "$pathspec" |
    LC_ALL=C sort -zu |
    while IFS= read -r -d '' deleted_file; do
      [[ -n "$deleted_file" ]] && printf '%s\n' "$deleted_file"
    done
}

main() {
  parse_arguments "$@"
  resolve_repository_directory
  list_deleted_files
}

main "$@"
