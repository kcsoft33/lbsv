# lbsv (LabSave) shell hook for bash ≥ 4. Source it from ~/.bashrc:
#   [ -f ~/.config/lbsv/lbsv.bash ] && . ~/.config/lbsv/lbsv.bash
#
# At each prompt this overwrites one small file, $LBSV_STATE_DIR/<pid>, using only shell builtins:
# no subprocess, no network, so it costs well under a millisecond. lbsv-agent reads these files.
# Recorded: pid, tty, user, host, cwd, tmux/screen session. Never command output.
# Command text only if you opt in with LBSV_RECORD_CMDS=1 (redacted again by the agent and the hub).

[[ $- == *i* ]] || return 0          # interactive shells only
[[ -n ${__lbsv_file-} ]] && return 0  # already loaded

__lbsv_dir=${LBSV_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lbsv/shells}
[[ -d $__lbsv_dir ]] || mkdir -p -- "$__lbsv_dir" 2>/dev/null || return 0
__lbsv_winpid=
[[ -r /proc/$$/winpid ]] && read -r __lbsv_winpid < /proc/$$/winpid  # Git Bash / MSYS / Cygwin on Windows
# Named by the Windows pid there, so it can't collide with a PowerShell's file.
__lbsv_file=$__lbsv_dir/${__lbsv_winpid:-$$}
__lbsv_started=${EPOCHSECONDS:-0}
# One-time lookup at startup (this forks; the per-prompt hook never does).
__lbsv_tty=$(tty 2>/dev/null) || __lbsv_tty=
__lbsv_host=${HOSTNAME:-}
__lbsv_user=${USER:-${USERNAME:-}}

__lbsv_hook() {
  local __s=$?
  {
    printf 'v=1\nshell=bash\npid=%s\nwinpid=%s\ntty=%s\nuser=%s\nhost=%s\nstarted=%s\ntmux=%s\ntmux_pane=%s\nsty=%s\ncwd=%s\n' \
      "$$" "$__lbsv_winpid" "$__lbsv_tty" "$__lbsv_user" "$__lbsv_host" "$__lbsv_started" "${TMUX-}" "${TMUX_PANE-}" "${STY-}" "$PWD"
    if [[ ${LBSV_RECORD_CMDS-0} == 1 ]]; then printf 'cmd='; HISTTIMEFORMAT= builtin history 1; fi
  } > "$__lbsv_file" 2>/dev/null
  return $__s
}

# Run first so $? is still the user's command status; keeps any existing PROMPT_COMMAND.
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__lbsv_hook "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__lbsv_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
