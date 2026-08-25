#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename -- "$0")"

print_usage() {
  cat <<EOF
用法: $SCRIPT_NAME [--all] <项目内目录>

沿当前分支的第一父提交链，列出指定目录及其所有子目录中曾被 Git 删除的文件。
默认不会统计其他分支或合并提交带入的删除；使用 --all 查询所有本地和远端跟踪分支。
文件路径相对于 Git 仓库根目录。相关分支表示当前仍包含对应提交的分支。

选项:
  --all       查询所有本地和远端跟踪分支的历史
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
  INCLUDE_ALL_BRANCHES=false
  TARGET_DIRECTORY=""

  while (($# > 0)); do
    case "$1" in
      --all)
        INCLUDE_ALL_BRANCHES=true
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

format_containing_branches() {
  local commit_id="$1"
  local branch_name
  local branch_names
  local separator=""

  branch_names="$(
    git -C "$REPOSITORY_ROOT" for-each-ref \
      --contains="$commit_id" \
      --format='%(refname:short)' \
      refs/heads refs/remotes
  )" || fail "无法查询提交 $commit_id 所在的分支"

  while IFS= read -r branch_name; do
    [[ -n "$branch_name" && "$branch_name" != */HEAD ]] || continue
    printf '%s%s' "$separator" "$branch_name"
    separator=", "
  done <<<"$branch_names"

  if [[ -z "$separator" ]]; then
    printf '%s' "无现存分支引用"
  fi
}

print_deleted_commit() {
  local commit_id="$1"
  local pathspec="$2"
  local containing_branches

  containing_branches="$(format_containing_branches "$commit_id")"

  git -C "$REPOSITORY_ROOT" show --no-patch \
    --format='----------------------------------------%nCommit ID: %H%n提交时间: %cI%n提交人: %cn <%ce>%n提交信息: %s' \
    "$commit_id"
  printf '相关分支: %s\n' "$containing_branches"
  printf '删除文件:\n\n'
  git -C "$REPOSITORY_ROOT" -c core.quotePath=false show \
    --format= \
    --diff-filter=D \
    --name-only \
    "$commit_id" \
    -- "$pathspec"
}

list_deleted_files() {
  local -a revision_scope=(HEAD --first-parent --no-merges)
  local commit_id
  local deleted_commit_ids
  local pathspec

  if [[ -n "$REPOSITORY_DIRECTORY" ]]; then
    pathspec=":(top,literal)$REPOSITORY_DIRECTORY"
  else
    pathspec=":(top)**"
  fi

  printf '当前分支: %s\n' "$CURRENT_BRANCH"
  printf '查询目录: %s\n\n' "${REPOSITORY_DIRECTORY:-.}"

  if [[ "$INCLUDE_ALL_BRANCHES" == true ]]; then
    revision_scope=(--branches --remotes)
    printf '历史范围: 所有本地和远端跟踪分支\n\n'
  else
    printf '历史范围: 当前分支第一父提交链（不含合并提交）\n\n'
  fi

  deleted_commit_ids="$(
    git -C "$REPOSITORY_ROOT" log \
      "${revision_scope[@]}" \
      --diff-filter=D \
      --format='%H' \
      -- "$pathspec"
  )" || fail "无法查询 Git 删除历史"

  if [[ -z "$deleted_commit_ids" ]]; then
    printf '未找到符合条件的删除记录。\n'
    return
  fi

  while IFS= read -r commit_id; do
    [[ -n "$commit_id" ]] || continue
    print_deleted_commit "$commit_id" "$pathspec"
  done <<<"$deleted_commit_ids"
}

main() {
  parse_arguments "$@"
  resolve_repository_directory
  list_deleted_files
}

main "$@"
