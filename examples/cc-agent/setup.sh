#!/usr/bin/env bash
# cc-agent — a separate Linux user the local agent works as.
#
# Inside it: no rules. Its own home (~/.pomodoro just works), its own deno/am,
# its own /run/user (am status tells the truth), its own screen.
# At its edge: your home closed, no sudo, localhost + LAN closed, capped
# memory/tasks, optionally no GPU.
#
# Run as YOURSELF in a real terminal (sudo asks for your password once):
#   bash examples/cc-agent/setup.sh            # user share display fence verify — the machine part, tool-free
#   bash examples/cc-agent/setup.sh tools app  # optional aio demo: the agent can install its own tools
#   bash examples/cc-agent/setup.sh verify     # any steps, in the order given
#   bash examples/cc-agent/setup.sh gpu verify # optional: wall off the GPUs too
#   bash examples/cc-agent/setup.sh mark       # …agent works… then: writes [home]
#   bash examples/cc-agent/setup.sh undo       # removes all of it, agent home included
set -euo pipefail

A=cc-agent
ME=$(id -un)
DISP=:90
AIO_SRC=${AIO_SRC:-$HOME/code/gen/aio}
say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
uid() { id -u "$A"; }

# One command line, as the agent, inside the agent's own systemd user manager —
# so its slice limits apply and what it starts lives on after the command.
as_agent() {
  local u; u=$(uid)
  sudo -u "$A" -H env -i \
    HOME="/home/$A" USER="$A" LOGNAME="$A" SHELL=/bin/bash LANG="${LANG:-C.UTF-8}" \
    PATH="/home/$A/.deno/bin:/home/$A/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    XDG_RUNTIME_DIR="/run/user/$u" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" \
    DISPLAY="$DISP" XAUTHORITY="/home/$A/.Xauthority" \
    systemd-run --user --scope --quiet --collect bash -c "cd ~ && $1"
}

step_user() {
  say "user $A — no sudo, no docker, no extra groups; lingering; capped"
  id "$A" >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash --user-group "$A"
  sudo chmod 750 "/home/$A"
  sudo loginctl enable-linger "$A"
  printf '%s ALL=(%s) NOPASSWD: ALL\n' "$ME" "$A" | sudo tee /etc/sudoers.d/cc-agent >/dev/null
  sudo chmod 440 /etc/sudoers.d/cc-agent
  sudo visudo -cf /etc/sudoers.d/cc-agent
  sudo systemctl set-property "user-$(uid).slice" MemoryMax=32G TasksMax=8192
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "/run/user/$(uid)/bus" ] && break; sleep 0.5; done
}

step_share() {
  say "share — ~$A/work is yours and its: projects there run as $A in cc"
  # cc's file tools run as you, the agent's commands as $A: default ACLs make
  # every file either of you creates there readable and writable by both.
  # Its git trusts every repo (one you create there is owned by you, and a
  # path pattern needs git 2.46) — its own account, nothing of yours to guard.
  sudo -u "$A" -H sh -c "cd ~ && mkdir -p work &&
    setfacl -m u:$ME:x . &&
    setfacl -R -m u:$ME:rwX,d:u:$ME:rwX,u:$A:rwX,d:u:$A:rwX work &&
    git config --global --replace-all safe.directory '*'"
  echo "→ in cc, open a project under /home/$A/work — the strip says 'as $A'"
}

step_tools() {
  say "deno + am for the agent, from your aio checkout at $AIO_SRC"
  [ -r "$AIO_SRC/install.sh" ] || { echo "no $AIO_SRC/install.sh — set AIO_SRC"; exit 1; }
  # Not a clone of your repo: git refuses another user's repo, and objects
  # committed under umask 077 (this machine's AI shells) are unreadable to
  # anyone else. A bundle is one plain file with every ref, made by you.
  local b=/tmp/cc-agent-aio.bundle
  rm -f "$b"
  git -C "$AIO_SRC" bundle create "$b" --all 2>/dev/null
  chmod 644 "$b"
  cp "$AIO_SRC/install.sh" /tmp/cc-agent-aio-install.sh && chmod 644 /tmp/cc-agent-aio-install.sh
  as_agent "git -C ~/.local/lib/aio rev-parse -q --verify HEAD >/dev/null 2>&1 || rm -rf ~/.local/lib/aio; AIO_REPO=$b sh /tmp/cc-agent-aio-install.sh"
  rm -f "$b" /tmp/cc-agent-aio-install.sh
}

step_display() {
  say "screen $DISP — a window on your desktop the agent draws in; it never gets :0"
  local auth="$HOME/.cc-agent-x.auth" cookie
  cookie=$(mcookie)
  rm -f "$auth"; (umask 077; : >"$auth")
  printf 'add %s . %s\n' "$DISP" "$cookie" | xauth -q -f "$auth" source -
  printf 'add %s . %s\n' "$DISP" "$cookie" |
    sudo -u "$A" -H sh -c "rm -f ~/.Xauthority; (umask 077; : >~/.Xauthority); xauth -q -f ~/.Xauthority source -"
  pkill -f "^Xephyr $DISP " || true
  nohup Xephyr "$DISP" -auth "$auth" -nolisten tcp -screen 1400x900 -resizeable \
    -title "cc-agent $DISP" >/dev/null 2>&1 &
  sleep 1
}

step_fence() {
  say "fence — your home closed; localhost and LAN closed to the agent (internet stays open)"
  chmod 700 "$HOME"
  sudo nft -f - <<EOF
table inet cc_agent
delete table inet cc_agent
table inet cc_agent {
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid $(uid) ip daddr 127.0.0.0/8 tcp dport != 53 reject with tcp reset
    meta skuid $(uid) ip6 daddr ::1 tcp dport != 53 reject with tcp reset
    meta skuid $(uid) ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } reject
  }
}
EOF
  echo "(nft rules last until reboot — persisting them comes after the spike)"
}

step_gpu() {
  say "gpu — the agent's slice may open only the standard pseudo-devices"
  sudo systemctl set-property "user-$(uid).slice" DevicePolicy=closed
}

step_verify() {
  say "verify — every line should be ✓"
  # chk <label> <command as agent> <expected: ok|fail>
  chk() {
    local got=fail
    as_agent "$2" >/dev/null 2>&1 && got=ok
    [ "$got" = "$3" ] && echo "✓ $1" || echo "✗ $1 (got $got, want $3)"
  }
  chk "runs as $A" '[ "$(id -un)" = cc-agent ]' ok
  chk "own /run/user" '[ -d "$XDG_RUNTIME_DIR" ] && [ -O "$XDG_RUNTIME_DIR" ]' ok
  chk "your home closed" "ls /home/$ME" fail
  chk "no sudo" 'sudo -n true' fail
  chk "internet open" 'curl -fsS -m 8 -o /dev/null https://jsr.io' ok
  chk "localhost services closed (ollama 11434)" 'curl -s -m 3 http://127.0.0.1:11434' fail
  chk "own screen $DISP open" "xdpyinfo -display $DISP" ok
  chk "your desktop :0 closed" 'XAUTHORITY=/dev/null xdpyinfo -display :0' fail
  # Every other X screen too: X is a local socket, no firewall rule reaches it —
  # a screen started without a cookie (Xephyr -ac, or no -auth) is open to the
  # agent, and a tool may put its windows there. Its starter has to add one.
  for s in /tmp/.X11-unix/X*; do
    [ -S "$s" ] || continue
    n=":${s##*/X}"
    [ "$n" = "$DISP" ] || [ "$n" = :0 ] || chk "screen $n closed" "XAUTHORITY=/dev/null xdpyinfo -display $n" fail
  done
  chk "memory cap in place" '[ "$(systemctl show "user-$(id -u).slice" -P MemoryMax)" != infinity ]' ok
  [ -w "/home/$A/work" ] && echo "✓ you can write its work folder" || echo "✗ you cannot write /home/$A/work (run: share)"
  echo "(GPU: after 'gpu', 'nvidia-smi' as the agent should fail — check with: bash $0 gpucheck)"
}

step_gpucheck() { as_agent 'nvidia-smi -L' && echo "✗ agent still sees the GPUs" || echo "✓ GPUs closed"; }

step_app() {
  say "app — the agent builds and shows an aio app on $DISP"
  as_agent 'mkdir -p ~/work && cd ~/work && rm -rf hello && am create hello --template=counter --target=electron && cd hello && { am start --client=electron --display=current || echo "(a cold first start downloads Electron and can outlast am start'"'"'s 10 s — status below is what counts)"; }; sleep 10; am status --app=hello'
  echo "→ a counter window should be inside the 'cc-agent $DISP' window"
}

# Where did the agent (and what it ran) write? Everything it creates is owned
# by it, so: `mark`, let it work, then `writes` lists what appeared outside
# its home. `writes home` includes the home too.
step_mark() { sudo -u "$A" touch "/home/$A/.cc-mark" && echo "marked — run 'writes' after the work"; }

step_writes() {
  say "files $A created or changed since the mark"
  # Only these can take a write from a plain user; / is not one filesystem here.
  local skip=(-path "/home/$ME" -o -path "/run/user/$(id -u)")
  [ "${1:-}" = home ] || skip+=(-o -path "/home/$A")
  sudo find /home /tmp /var/tmp /dev/shm /run /var/crash \( "${skip[@]}" \) -prune \
    -o -user "$A" -newer "/home/$A/.cc-mark" -print 2>/dev/null |
    sed -E 's#(/[^/]+/[^/]+/[^/]+/[^/]+)/.*#\1/…#' | sort | uniq -c | sort -rn
}

step_undo() {
  say "undo — removes the user, its home, its rules and its screen"
  pkill -f "^Xephyr $DISP " || true
  rm -f "$HOME/.cc-agent-x.auth"
  sudo nft delete table inet cc_agent 2>/dev/null || true
  chmod 755 "$HOME"
  if id "$A" >/dev/null 2>&1; then
    sudo systemctl revert "user-$(uid).slice" 2>/dev/null || true
    sudo loginctl disable-linger "$A" || true
    sudo pkill -KILL -u "$A" || true
    sudo userdel -r "$A" 2>/dev/null || true
  fi
  sudo rm -f /etc/sudoers.d/cc-agent
}

[ "$(id -u)" != 0 ] || { echo "run as yourself, not root"; exit 1; }
steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(user share display fence verify)
for s in "${steps[@]}"; do
  case $s in home) continue ;; esac # an argument to `writes`, not a step
  if [ "$s" = writes ] && [[ " ${steps[*]} " == *" writes home "* ]]; then step_writes home; else "step_$s"; fi
done
