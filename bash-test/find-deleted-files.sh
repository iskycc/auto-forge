#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename -- "$0")"

print_usage() {
  cat <<EOF
用法: $SCRIPT_NAME [--all | --branch <分支>] <项目内目录>

沿当前分支的第一父提交链，列出指定目录及其所有子目录中曾被 Git 删除的文件。
默认不会统计其他分支或合并提交带入的删除；使用 --all 查询所有本地和远端跟踪分支。
使用 --branch 只查询指定分支；短名称会同时匹配本地分支和各 remote 下的同名分支。
结果按提交时间从新到旧写入项目根目录的 delete-result.log。
文件路径相对于 Git 仓库根目录。相关分支表示当前仍包含对应提交的分支。

选项:
  --all              查询所有本地和远端跟踪分支的历史
  -b, --branch NAME  只查询指定分支及其对应的远端跟踪分支
  -h, --help         显示帮助

示例:
  $SCRIPT_NAME apps/web/src
  $SCRIPT_NAME --all packages/db
  $SCRIPT_NAME --branch ci1cases packages/db
  $SCRIPT_NAME --branch origin/ci1cases packages/db
EOF
}

fail() {
  printf '错误: %s\n' "$1" >&2
  exit 1
}

cleanup_temporary_output() {
  if [[ -n "${TEMPORARY_OUTPUT_FILE:-}" && -f "$TEMPORARY_OUTPUT_FILE" ]]; then
    rm -f -- "$TEMPORARY_OUTPUT_FILE"
  fi
}

parse_arguments() {
  BRANCH_FILTER=""
  INCLUDE_ALL_BRANCHES=false
  TARGET_DIRECTORY=""

  while (($# > 0)); do
    case "$1" in
      --all)
        INCLUDE_ALL_BRANCHES=true
        ;;
      -b | --branch)
        shift
        (($# > 0)) || fail "--branch 需要指定分支名"
        [[ -z "$BRANCH_FILTER" ]] || fail "只能指定一个分支筛选条件"
        BRANCH_FILTER="$1"
        ;;
      --branch=*)
        [[ -z "$BRANCH_FILTER" ]] || fail "只能指定一个分支筛选条件"
        BRANCH_FILTER="${1#*=}"
        [[ -n "$BRANCH_FILTER" ]] || fail "--branch 需要指定分支名"
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

  if [[ "$INCLUDE_ALL_BRANCHES" == true && -n "$BRANCH_FILTER" ]]; then
    fail "--all 与 --branch 不能同时使用"
  fi

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

append_filtered_branch() {
  local full_ref="$1"
  local short_ref

  case "$full_ref" in
    refs/heads/*)
      short_ref="${full_ref#refs/heads/}"
      ;;
    refs/remotes/*)
      short_ref="${full_ref#refs/remotes/}"
      ;;
    *)
      fail "不支持的分支引用: $full_ref"
      ;;
  esac

  FILTERED_BRANCH_REFS+=("$full_ref")
  FILTERED_BRANCH_NAMES+=("$short_ref")
}

resolve_branch_filter() {
  local local_ref
  local remote_name
  local remote_names
  local remote_ref

  [[ -n "$BRANCH_FILTER" ]] || return 0
  git check-ref-format "refs/heads/$BRANCH_FILTER" >/dev/null 2>&1 ||
    fail "分支名格式无效: $BRANCH_FILTER"

  FILTERED_BRANCH_REFS=()
  FILTERED_BRANCH_NAMES=()

  remote_ref="refs/remotes/$BRANCH_FILTER"
  if git -C "$REPOSITORY_ROOT" show-ref --verify --quiet "$remote_ref"; then
    append_filtered_branch "$remote_ref"
    return
  fi

  local_ref="refs/heads/$BRANCH_FILTER"
  if git -C "$REPOSITORY_ROOT" show-ref --verify --quiet "$local_ref"; then
    append_filtered_branch "$local_ref"
  fi

  remote_names="$(git -C "$REPOSITORY_ROOT" remote)" ||
    fail "无法读取 Git remote"

  while IFS= read -r remote_name; do
    [[ -n "$remote_name" ]] || continue
    remote_ref="refs/remotes/$remote_name/$BRANCH_FILTER"
    if git -C "$REPOSITORY_ROOT" show-ref --verify --quiet "$remote_ref"; then
      append_filtered_branch "$remote_ref"
    fi
  done <<<"$remote_names"

  ((${#FILTERED_BRANCH_REFS[@]} > 0)) ||
    fail "未找到分支 '$BRANCH_FILTER'；请使用 git branch -a 查看可用分支"
}

join_with_comma() {
  local item
  local separator=""

  for item in "$@"; do
    printf '%s%s' "$separator" "$item"
    separator=", "
  done
}

format_containing_branches() {
  local commit_id="$1"
  local branch_index
  local branch_name
  local branch_names
  local contains_status
  local separator=""

  if [[ -n "$BRANCH_FILTER" ]]; then
    for branch_index in "${!FILTERED_BRANCH_REFS[@]}"; do
      if git -C "$REPOSITORY_ROOT" merge-base --is-ancestor \
        "$commit_id" "${FILTERED_BRANCH_REFS[$branch_index]}"; then
        printf '%s%s' "$separator" "${FILTERED_BRANCH_NAMES[$branch_index]}"
        separator=", "
      else
        contains_status=$?
        ((contains_status == 1)) ||
          fail "无法判断提交 $commit_id 与分支 ${FILTERED_BRANCH_NAMES[$branch_index]} 的关系"
      fi
    done

    [[ -n "$separator" ]] || printf '%s' "无现存分支引用"
    return
  fi

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
  local -a deleted_commit_ids=()
  local -a revision_scope=(HEAD --first-parent --no-merges)
  local commit_id
  local commit_timestamp
  local deleted_commit_records
  local pathspec
  local processed_commit_count=0
  local progress_percent
  local total_commit_count

  if [[ -n "$REPOSITORY_DIRECTORY" ]]; then
    pathspec=":(top,literal)$REPOSITORY_DIRECTORY"
  else
    pathspec=":(top)**"
  fi

  printf '当前分支: %s\n' "$CURRENT_BRANCH"
  printf '查询目录: %s\n\n' "${REPOSITORY_DIRECTORY:-.}"

  if [[ -n "$BRANCH_FILTER" ]]; then
    revision_scope=("${FILTERED_BRANCH_REFS[@]}")
    printf '历史范围: 指定分支 %s\n\n' "$(join_with_comma "${FILTERED_BRANCH_NAMES[@]}")"
  elif [[ "$INCLUDE_ALL_BRANCHES" == true ]]; then
    revision_scope=(--branches --remotes)
    printf '历史范围: 所有本地和远端跟踪分支\n\n'
  else
    printf '历史范围: 当前分支第一父提交链（不含合并提交）\n\n'
  fi

  printf '正在查找删除提交，请稍候...\n' >&2
  deleted_commit_records="$(
    git -C "$REPOSITORY_ROOT" log \
      "${revision_scope[@]}" \
      --diff-filter=D \
      --format='%ct %H' \
      -- "$pathspec" |
      LC_ALL=C sort -k1,1nr -k2,2
  )" || fail "无法查询 Git 删除历史"

  if [[ -n "$deleted_commit_records" ]]; then
    while IFS=' ' read -r commit_timestamp commit_id; do
      [[ -n "$commit_timestamp" && -n "$commit_id" ]] || continue
      deleted_commit_ids+=("$commit_id")
    done <<<"$deleted_commit_records"
  fi

  total_commit_count="${#deleted_commit_ids[@]}"
  printf '找到 %d 个删除提交。\n' "$total_commit_count" >&2

  if ((total_commit_count == 0)); then
    printf '未找到符合条件的删除记录。\n'
    return
  fi

  for commit_id in "${deleted_commit_ids[@]}"; do
    ((processed_commit_count += 1))
    progress_percent=$((processed_commit_count * 100 / total_commit_count))
    printf '\r处理进度: %d/%d (%3d%%) Commit %.12s' \
      "$processed_commit_count" \
      "$total_commit_count" \
      "$progress_percent" \
      "$commit_id" >&2
    print_deleted_commit "$commit_id" "$pathspec"
  done

  printf '\n' >&2
}

write_result_file() {
  OUTPUT_FILE="$REPOSITORY_ROOT/delete-result.log"
  TEMPORARY_OUTPUT_FILE="$(mktemp "$REPOSITORY_ROOT/.delete-result.log.tmp.XXXXXX")" ||
    fail "无法在项目根目录创建临时结果文件"
  trap cleanup_temporary_output EXIT

  printf '结果文件: %s\n' "$OUTPUT_FILE" >&2
  list_deleted_files >"$TEMPORARY_OUTPUT_FILE"
  chmod 0644 "$TEMPORARY_OUTPUT_FILE"
  mv -- "$TEMPORARY_OUTPUT_FILE" "$OUTPUT_FILE"
  TEMPORARY_OUTPUT_FILE=""

  printf '扫描完成，结果已写入 %s\n' "$OUTPUT_FILE" >&2
}

main() {
  parse_arguments "$@"
  resolve_repository_directory
  resolve_branch_filter
  write_result_file
}

main "$@"
