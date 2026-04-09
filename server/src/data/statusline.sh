#!/bin/bash
# OctoAlly Status Line for Claude Code
# Based on Mohamed3on's statusline (MIT) — customized with git branch, no node info

export TERM=xterm-256color

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir')

model=$(echo "$input" | jq -r '.model.display_name // empty')
model_id=$(echo "$input" | jq -r '.model.id // empty')

# Token usage
input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
context_limit=$(echo "$input" | jq -r '.context_window.context_window_size // 0')
total_tokens=$((input_tokens + output_tokens))

# Cost & stats
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
duration_ms=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')
lines_added=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
lines_removed=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')

# Colors
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
MAGENTA=$'\033[35m'
CYAN=$'\033[36m'
GRAY=$'\033[90m'
RESET=$'\033[0m'

SEP="${GRAY}${RESET}"

short_dir=$(basename "$cwd")

# Git branch
git_info=""
if branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null); then
  git_info=" ${SEP} ${MAGENTA} ${branch}${RESET}"
elif branch=$(git -C "$cwd" describe --tags --exact-match 2>/dev/null); then
  git_info=" ${SEP} ${MAGENTA} ${branch}${RESET}"
fi

# Session duration
duration_info=""
if [ "$duration_ms" -gt 0 ] 2>/dev/null; then
  duration_sec=$((duration_ms / 1000))
  if [ "$duration_sec" -ge 3600 ]; then
    hours=$((duration_sec / 3600))
    mins=$(((duration_sec % 3600) / 60))
    duration_fmt="${hours}h${mins}m"
  elif [ "$duration_sec" -ge 60 ]; then
    mins=$((duration_sec / 60))
    duration_fmt="${mins}m"
  else
    duration_fmt="${duration_sec}s"
  fi
  duration_info=" ${SEP} ${CYAN}⏱ ${duration_fmt}${RESET}"
fi

# Lines changed
lines_info=""
if [ "$lines_added" -gt 0 ] || [ "$lines_removed" -gt 0 ] 2>/dev/null; then
  net=$((lines_added - lines_removed))
  if [ "$net" -gt 0 ]; then
    net_symbol="${GREEN}▲${RESET}"
  elif [ "$net" -lt 0 ]; then
    net_symbol="${RED}▼${RESET}"
  else
    net_symbol="${GRAY}=${RESET}"
  fi
  lines_info=" ${SEP} ${net_symbol} ${GREEN}+${lines_added}${RESET} ${RED}-${lines_removed}${RESET}"
fi

# Token usage with progress bar
token_info=""
if [ "$total_tokens" -gt 0 ] 2>/dev/null; then
  if [ "$context_limit" -gt 0 ] 2>/dev/null; then
    pct=$((total_tokens * 100 / context_limit))
    if [ "$pct" -ge 75 ]; then
      bar_color="$RED"
    elif [ "$pct" -ge 50 ]; then
      bar_color="$YELLOW"
    else
      bar_color="$GREEN"
    fi
    bar_width=8
    filled=$((pct * bar_width / 100))
    [ "$filled" -gt "$bar_width" ] && filled=$bar_width
    [ "$filled" -lt 1 ] && [ "$pct" -gt 0 ] && filled=1
    empty=$((bar_width - filled))
    bar="${bar_color}"
    for ((i=0; i<filled; i++)); do bar+="▓"; done
    bar+="${GRAY}"
    for ((i=0; i<empty; i++)); do bar+="░"; done
    bar+="${RESET}"
    token_info=" ${SEP} ${bar} ${GRAY}${pct}%${RESET}"
  fi
fi

# Cost
cost_info=""
if [ -n "$cost" ] && [ "$cost" != "null" ]; then
  cost_fmt=$(printf "%.2f" "$cost")
  cost_cents=$(printf "%.0f" "$(echo "$cost * 100" | bc)")
  if [ "$cost_cents" -ge 1000 ] 2>/dev/null; then
    cost_color="$RED"
  elif [ "$cost_cents" -ge 200 ] 2>/dev/null; then
    cost_color="$YELLOW"
  else
    cost_color="$GREEN"
  fi
  cost_info=" ${SEP} ${cost_color}\$${cost_fmt}${RESET}"
fi

# Model with version, tier colors, and context size
model_info=""
if [ -n "$model_id" ] || [ -n "$model" ]; then
  # Determine tier name, color, and symbol from model.id first, fall back to display_name
  model_color="$GRAY"; model_symbol="●"; tier=""
  case "${model_id:-$model}" in
    *opus*|*Opus*) model_color="$MAGENTA"; model_symbol="◆"; tier="Opus" ;;
    *sonnet*|*Sonnet*) model_color="$BLUE"; model_symbol="◇"; tier="Sonnet" ;;
    *haiku*|*Haiku*) model_color="$GREEN"; model_symbol="○"; tier="Haiku" ;;
  esac
  [ -z "$tier" ] && tier="$model"

  # Extract version from model.id (e.g. claude-opus-4-6 → 4.6)
  version=""
  case "$model_id" in
    *-4-6*) version="4.6" ;;
    *-4-5*) version="4.5" ;;
    *-4-1*) version="4.1" ;;
    *-4-0*|*-4-2025*) version="4" ;;
    *-3-*) version="3" ;;
  esac

  # Context window size tag
  ctx_tag=""
  if [ "$context_limit" -ge 1000000 ] 2>/dev/null; then
    ctx_tag=" ${GRAY}1M${RESET}"
  elif [ "$context_limit" -ge 200000 ] 2>/dev/null; then
    ctx_tag=" ${GRAY}200k${RESET}"
  fi

  # Build label: "Opus 4.6 1M" — assembled from parts, not display_name
  label="${tier}"
  [ -n "$version" ] && label="${tier} ${version}"
  model_info=" ${SEP} ${model_color}${model_symbol} ${label}${ctx_tag}${RESET}"
fi

printf "${BLUE}${short_dir}${RESET}%s%s%s%s%s%s" "$git_info" "$duration_info" "$lines_info" "$token_info" "$cost_info" "$model_info"
