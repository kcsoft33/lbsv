# lbsv (LabSave) shell hook for zsh. Source it from ~/.zshrc:
#   [[ -f ~/.config/lbsv/lbsv.zsh ]] && source ~/.config/lbsv/lbsv.zsh
#
# At each prompt (precmd) and directory change (chpwd) this overwrites one small file,
# $LBSV_STATE_DIR/<pid>, using only builtins: no subprocess, no network.
# Recorded: pid, tty, user, host, cwd, tmux/screen session. Never command output.
# Command text only if you opt in with LBSV_RECORD_CMDS=1 (redacted again by the agent and the hub).

[[ -o interactive ]] || return 0
[[ -n ${__lbsv_file-} ]] && return 0

zmodload zsh/datetime 2>/dev/null
typeset -g __lbsv_dir=${LBSV_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lbsv/shells}
[[ -d $__lbsv_dir ]] || mkdir -p -- $__lbsv_dir 2>/dev/null || return 0
typeset -g __lbsv_file=$__lbsv_dir/$$
typeset -g __lbsv_started=${EPOCHSECONDS:-0}
typeset -g __lbsv_tty=${TTY:-}
typeset -g __lbsv_cmd=

__lbsv_preexec() { [[ ${LBSV_RECORD_CMDS-0} == 1 ]] && __lbsv_cmd=$1 }
__lbsv_hook() {
  local __s=$?
  {
    print -r -- "v=1"$'\n'"shell=zsh"$'\n'"pid=$$"$'\n'"tty=$__lbsv_tty"$'\n'"user=${USER-}"$'\n'"host=${HOST-}"$'\n'"started=$__lbsv_started"$'\n'"tmux=${TMUX-}"$'\n'"tmux_pane=${TMUX_PANE-}"$'\n'"sty=${STY-}"$'\n'"cwd=$PWD"
    [[ ${LBSV_RECORD_CMDS-0} == 1 && -n $__lbsv_cmd ]] && print -r -- "cmd=$__lbsv_cmd"
  } >| $__lbsv_file 2>/dev/null
  return $__s
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __lbsv_hook
add-zsh-hook chpwd __lbsv_hook
add-zsh-hook preexec __lbsv_preexec
