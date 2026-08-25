#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename -- "$0")"

print_usage() {
  cat <<EOF
用法: $SCRIPT_NAME <项目内目录>

沿当前分支的第一父提交链，列出指定目录及其所有子目录中曾被 Git 删除的文件。
不会遍历其他分支，也不会统计合并提交带入的删除。文件路径相对于 Git 仓库根目录。

选项:
  -h, --help  显示帮助

示例:
  $SCRIPT_NAME apps/web/src
  $SCRIPT_NAME packages/db
EOF
}

fail() {
  printf '错误: %s\n' "$1" >&2
  exit 1
}

parse_arguments() {
  TARGET_DIRECTORY=""

  while (($# > 0)); do
    case "$1" in
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
  CURRENT_BRANCH="$(git -C "$REPOSITORY_ROOT" symbolic-ref --quiet --short HEAD)" ||
    fail "当前仓库处于 detached HEAD 状态，无法确定当前分支"
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
  local pathspec

  if [[ -n "$REPOSITORY_DIRECTORY" ]]; then
    pathspec=":(top,literal)$REPOSITORY_DIRECTORY"
  else
    pathspec=":(top)**"
  fi

  printf '当前分支: %s\n' "$CURRENT_BRANCH"
  printf '查询目录: %s\n\n' "${REPOSITORY_DIRECTORY:-.}"

  git -C "$REPOSITORY_ROOT" -c core.quotePath=false log HEAD \
    --first-parent \
    --no-merges \
    --diff-filter=D \
    --format='----------------------------------------%nCommit ID: %H%n提交时间: %cI%n提交人: %cn <%ce>%n提交信息: %s%n删除文件:' \
    --name-only \
    -- "$pathspec"
}

main() {
  parse_arguments "$@"
  resolve_repository_directory
  list_deleted_files
}

main "$@"
