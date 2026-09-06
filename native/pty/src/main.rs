//! A pseudo-terminal, hosted for a process that cannot fork.
//!
//! # Why this exists at all
//!
//! A terminal emulator is not a shell. To run `bash` — with job control, colour,
//! `vim`, `htop`, tab completion, `Ctrl-C` — something has to hand it a real
//! *controlling terminal*: a kernel PTY pair, with the shell on the slave side
//! and its own session and process group. Nothing else is a shell; a program
//! that reads commands and prints answers is an imitation that stops working
//! the moment somebody runs `less`.
//!
//! The app that needs one is a Deno process, and Deno has no PTY API. It also
//! cannot safely `fork()`: it is multithreaded, and between `fork` and `exec`
//! only async-signal-safe calls are legal — returning into a JavaScript runtime
//! there is undefined behaviour, not a bug you can test for. So the fork
//! happens here, in a single-threaded program whose only job is to do it, and
//! the two sides talk over a pipe.
//!
//! # Protocol
//!
//! Both directions carry the same frame: one type byte, four big-endian length
//! bytes, then the payload. Framing rather than a raw stream because two things
//! travel each way and they must not be able to be mistaken for one another —
//! a resize is not four bytes of somebody's password.
//!
//! ```text
//!   in   0 data      the bytes to write to the terminal
//!        1 resize    u16 rows, u16 cols
//!   out  0 data      the bytes the terminal produced
//!        1 exited    i32 exit status, or 128+signal when a signal ended it
//! ```
//!
//! There is deliberately no "send a signal" frame. `Ctrl-C` is not a signal
//! sent to a pid — it is the byte `0x03`, written to the terminal, which the
//! line discipline turns into `SIGINT` for whatever is in the *foreground
//! process group* at that moment. A frame that signalled the child reached the
//! shell and not the `sleep` it was waiting on, which is measurably not what
//! `Ctrl-C` does; it was written, tested, found to do nothing useful, and
//! removed. Ending a session is the parent closing this process: the kernel
//! then hangs up the session, exactly as closing a terminal window does.
//!
//! # Arguments
//!
//! ```text
//!   cc-pty --rows <n> --cols <n> [--cwd <dir>] [--env K=V]... -- <argv0> [arg]...
//! ```

use std::ffi::{CStr, CString};
use std::io::{Read, Write};
use std::os::raw::{c_char, c_int, c_short, c_ulong, c_void};
use std::process::exit;

/* ── the nine pieces of libc this needs ───────────────────────────────────── */

#[repr(C)]
#[derive(Clone, Copy)]
struct Winsize {
    ws_row: u16,
    ws_col: u16,
    ws_xpixel: u16,
    ws_ypixel: u16,
}

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: c_short,
    revents: c_short,
}

const POLLIN: c_short = 0x001;
const POLLHUP: c_short = 0x010;
const POLLERR: c_short = 0x008;

// `TIOCSWINSZ` is the one constant that differs between the two platforms this
// builds for, and getting it wrong resizes nothing and reports success.
#[cfg(target_os = "linux")]
const TIOCSWINSZ: c_ulong = 0x5414;
#[cfg(target_os = "macos")]
const TIOCSWINSZ: c_ulong = 0x80087467;

// On Linux `forkpty` lives in libutil (a stub since glibc 2.34, still linked by
// name); on macOS it is part of libSystem, which is always linked.
#[cfg_attr(target_os = "linux", link(name = "util"))]
extern "C" {
    fn forkpty(
        amaster: *mut c_int,
        name: *mut c_char,
        termp: *const c_void,
        winp: *const Winsize,
    ) -> c_int;
    fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    fn poll(fds: *mut PollFd, nfds: c_ulong, timeout: c_int) -> c_int;
    fn read(fd: c_int, buf: *mut c_void, count: usize) -> isize;
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
    fn close(fd: c_int) -> c_int;
    fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
    fn kill(pid: c_int, sig: c_int) -> c_int;
    /// The process group currently in the FOREGROUND of this terminal. It is
    /// the shell's own group at a prompt, and the command's group while one
    /// runs — which is what "is something happening in here" really means.
    fn tcgetpgrp(fd: c_int) -> c_int;
    fn execvp(file: *const c_char, argv: *const *const c_char) -> c_int;
    fn chdir(path: *const c_char) -> c_int;
    fn setenv(name: *const c_char, value: *const c_char, overwrite: c_int) -> c_int;
    fn _exit(status: c_int) -> !;
    fn __errno_location() -> *mut c_int;
}

#[cfg(target_os = "linux")]
fn errno() -> c_int {
    unsafe { *__errno_location() }
}
#[cfg(not(target_os = "linux"))]
fn errno() -> c_int {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

const SIGKILL: c_int = 9;

const EINTR: c_int = 4;
const EAGAIN: c_int = 11;
const EIO: c_int = 5;

/* ── frames ───────────────────────────────────────────────────────────────── */

const IN_DATA: u8 = 0;
const IN_RESIZE: u8 = 1;
const OUT_DATA: u8 = 0;
const OUT_EXITED: u8 = 1;
/// One byte — 1 while a command holds the terminal's foreground, 0 at a prompt
/// — followed by that command's short name, when there is one. Sent when
/// either half changes, so a pipeline that moves from `cargo` to `rustc`
/// reports the second without going idle in between.
const OUT_BUSY: u8 = 2;
/// Quiet polls before "idle" is believed. The poll below waits 200ms when
/// nothing is happening, so this is roughly half a second — long enough to
/// cover the handover between two commands, short enough that a finished
/// command's light goes out while you are still looking at it.
const IDLE_TICKS: u8 = 3;

/// Write one frame to stdout, and flush it.
///
/// Flushed every time on purpose: this is a terminal, and output that arrives
/// when the buffer happens to fill is output that arrives at the wrong moment —
/// a prompt that appears only after the next keystroke reads as a hang.
fn emit(kind: u8, payload: &[u8]) {
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..5].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    let out = std::io::stdout();
    let mut out = out.lock();
    // A broken pipe means the parent is gone; there is nobody left to tell.
    if out.write_all(&head).is_err() || out.write_all(payload).is_err() {
        exit(0);
    }
    let _ = out.flush();
}

/* ── arguments ────────────────────────────────────────────────────────────── */

struct Args {
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    env: Vec<(String, String)>,
    argv: Vec<String>,
}

fn parse_args() -> Args {
    let mut rows = 24u16;
    let mut cols = 80u16;
    let mut cwd = None;
    let mut env = Vec::new();
    let mut argv = Vec::new();
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--rows" => rows = it.next().and_then(|v| v.parse().ok()).unwrap_or(24),
            "--cols" => cols = it.next().and_then(|v| v.parse().ok()).unwrap_or(80),
            "--cwd" => cwd = it.next(),
            "--env" => {
                if let Some(kv) = it.next() {
                    if let Some((k, v)) = kv.split_once('=') {
                        env.push((k.to_string(), v.to_string()));
                    }
                }
            }
            "--" => {
                argv.extend(it.by_ref());
                break;
            }
            other => {
                eprintln!("cc-pty: unknown option {other}");
                exit(2);
            }
        }
    }
    if argv.is_empty() {
        eprintln!("cc-pty: nothing to run — pass the command after --");
        exit(2);
    }
    Args { rows, cols, cwd, env, argv }
}

/* ── the child ────────────────────────────────────────────────────────────── */

/// Everything the child does between `fork` and `exec`.
///
/// Only async-signal-safe calls, and no allocation: this runs in a forked copy
/// of a process, and the rule is not a style preference. Every string it needs
/// is built *before* the fork and passed in already terminated.
unsafe fn become_the_shell(
    cwd: Option<&CStr>,
    env: &[(CString, CString)],
    argv: &[*const c_char],
) -> ! {
    if let Some(dir) = cwd {
        // A directory that has been deleted is not worth dying for — the shell
        // starts in whatever it inherited and the user can see where they are.
        chdir(dir.as_ptr());
    }
    for (k, v) in env {
        setenv(k.as_ptr(), v.as_ptr(), 1);
    }
    execvp(argv[0], argv.as_ptr());
    // Only reachable if exec failed. 127 is what a shell reports for
    // "command not found", and the parent turns it into a sentence.
    _exit(127);
}

/* ── main ─────────────────────────────────────────────────────────────────── */

fn main() {
    let args = parse_args();

    // Everything the child touches, allocated and terminated here — before the
    // fork, where allocation is still legal.
    let argv_owned: Vec<CString> = args
        .argv
        .iter()
        .map(|s| CString::new(s.as_str()).unwrap_or_else(|_| CString::new("").unwrap()))
        .collect();
    let mut argv_ptrs: Vec<*const c_char> = argv_owned.iter().map(|c| c.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());

    let cwd_c = args.cwd.as_ref().and_then(|d| CString::new(d.as_str()).ok());
    let env_c: Vec<(CString, CString)> = args
        .env
        .iter()
        .filter_map(|(k, v)| Some((CString::new(k.as_str()).ok()?, CString::new(v.as_str()).ok()?)))
        .collect();

    let size = Winsize {
        ws_row: args.rows,
        ws_col: args.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let mut master: c_int = -1;
    let pid = unsafe { forkpty(&mut master, std::ptr::null_mut(), std::ptr::null(), &size) };
    if pid < 0 {
        emit(OUT_DATA, b"cc-pty: could not open a pseudo-terminal\r\n");
        emit(OUT_EXITED, &(-1i32).to_be_bytes());
        exit(1);
    }
    if pid == 0 {
        unsafe {
            become_the_shell(
                cwd_c.as_deref(),
                &env_c,
                &argv_ptrs,
            )
        }
    }

    pump(master, pid);
}

/// Move bytes between the parent's stdin/stdout and the terminal, until the
/// child is gone and the terminal has nothing left to say.
fn pump(master: c_int, child: c_int) -> ! {
    let mut inbuf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 65536];
    let mut exited: Option<i32> = None;

    // Whether a command is running, as the terminal itself knows it.
    //
    // `forkpty` made the shell a session leader, so the shell's process group
    // IS its pid. Under job control the shell puts each command it runs into a
    // group of its own and hands the terminal to it, so "foreground group is
    // not the shell" means "a command is running" — and it is true for
    // `sleep 30`, which prints nothing at all. Watching output instead would
    // call that idle, and would call a slow build idle between its lines.
    let mut busy = false;
    let mut idle_ticks = 0u8;
    let mut name = String::new();
    emit(OUT_BUSY, &[0]);

    loop {
        let mut fds = [
            PollFd { fd: 0, events: POLLIN, revents: 0 },
            PollFd { fd: master, events: POLLIN, revents: 0 },
        ];
        let ready = unsafe { poll(fds.as_mut_ptr(), 2, 200) };
        if ready < 0 && errno() != EINTR {
            break;
        }

        // ── the terminal had something to say ──
        //
        // Read FIRST, always. A child that exits leaves its last output in the
        // buffer, and reporting the exit before draining it loses the answer to
        // whatever the user just ran.
        if fds[1].revents & (POLLIN | POLLHUP | POLLERR) != 0 {
            loop {
                let got = unsafe { read(master, chunk.as_mut_ptr() as *mut c_void, chunk.len()) };
                if got > 0 {
                    emit(OUT_DATA, &chunk[..got as usize]);
                    // Keep draining only while a full buffer says there is more;
                    // otherwise go back to poll so keystrokes are not starved by
                    // a program that prints without pausing.
                    if (got as usize) < chunk.len() {
                        break;
                    }
                    continue;
                }
                if got == 0 {
                    // The slave side closed: the session is over.
                    exited = exited.or(Some(0));
                    break;
                }
                let e = errno();
                if e == EINTR {
                    continue;
                }
                if e == EAGAIN {
                    break;
                }
                // EIO is how Linux reports "the last slave closed". It is the
                // normal end of a session, not a failure.
                if e == EIO {
                    exited = exited.or(Some(0));
                }
                break;
            }
        }

        // ── the app had something to send ──
        if fds[0].revents & (POLLIN | POLLHUP | POLLERR) != 0 {
            let mut buf = [0u8; 16384];
            match std::io::stdin().read(&mut buf) {
                // The app is gone. A terminal whose window has closed hangs up
                // on what was running in it — that is what every terminal
                // emulator does, and without it a shell started by an app that
                // is later killed outlives it forever, holding whatever it was
                // running. `SIGHUP` to the process GROUP, because the thing to
                // end is the pipeline in the foreground, not just the shell.
                Ok(0) => break,
                Ok(got) => {
                    inbuf.extend_from_slice(&buf[..got]);
                    // A frame this host cannot parse means the app and the
                    // host disagree about the protocol. There is no way to
                    // type into this terminal any more, so hang up rather
                    // than leave an unreachable shell behind.
                    if !consume(&mut inbuf, master) {
                        break;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }

        // ── is a command holding the terminal? ──
        //
        // Read every tick. It is one syscall on an fd already open, cheaper
        // than the poll that just returned, and it is edge-reported: the app
        // hears only when the answer changes.
        {
            let fg = unsafe { tcgetpgrp(master) };
            // A negative answer means the terminal has no foreground group any
            // more — the session is ending. Not busy.
            let now = fg > 0 && fg != child;
            if now {
                idle_ticks = 0;
                let found = comm_of(fg);
                if !busy || found != name {
                    busy = true;
                    name = found;
                    let mut frame = Vec::with_capacity(1 + name.len());
                    frame.push(1);
                    frame.extend_from_slice(name.as_bytes());
                    emit(OUT_BUSY, &frame);
                }
            } else if busy {
                // Going idle waits for a few quiet ticks; going busy does not.
                //
                // A pipeline hands the terminal from one command to the next,
                // and a shell is honestly "at a prompt" for the moment in
                // between. Reported as it happens, a `make` running a hundred
                // short commands strobes. The wait belongs HERE rather than in
                // the app, because the app cannot re-render when a deadline
                // passes — nothing changes at that instant for it to notice,
                // and a light left on until the next unrelated event is worse
                // than no light. Here there is already a loop with a clock.
                idle_ticks += 1;
                if idle_ticks >= IDLE_TICKS {
                    busy = false;
                    name.clear();
                    emit(OUT_BUSY, &[0]);
                }
            }
        }

        // ── has the child finished? ──
        if exited.is_none() {
            let mut status: c_int = 0;
            // WNOHANG
            let done = unsafe { waitpid(child, &mut status, 1) };
            if done == child {
                exited = Some(wait_code(status));
                // Loop once more rather than leaving now: the terminal may
                // still hold the output the child wrote on its way out.
                continue;
            }
        } else {
            break;
        }
    }

    // Hang up on a session nobody can read any more.
    //
    // Closing the master is the whole mechanism, and it has to come FIRST. The
    // kernel is what turns a closed terminal into `SIGHUP`, and it sends it to
    // the terminal's foreground process GROUP — which under job control is the
    // command that is running, not the shell. Signalling the shell's own group
    // instead reaches only the shell, and a `deno task dev` started in this
    // terminal would go on serving with nothing attached to it.
    //
    // On the ordinary path — the child exited on its own — this is just the
    // close that was always here, one step earlier.
    unsafe { close(master) };

    if exited.is_none() {
        // A grace period, then insist: a process that ignores `SIGHUP` must
        // not keep this host, and its shell, alive forever.
        for _ in 0..100 {
            let mut status: c_int = 0;
            if unsafe { waitpid(child, &mut status, 1) } == child {
                exited = Some(wait_code(status));
                break;
            }
            unsafe { poll(std::ptr::null_mut(), 0, 10) };
        }
        if exited.is_none() {
            unsafe { kill(-child, SIGKILL) };
        }
    }

    // Reap, in case the loop left through the terminal rather than the child.
    let mut status: c_int = 0;
    let code = match exited {
        Some(c) if c != 0 => c,
        _ => {
            unsafe { waitpid(child, &mut status, 0) };
            wait_code(status)
        }
    };
    emit(OUT_EXITED, &code.to_be_bytes());
    exit(0);
}

/// The short name of the process leading group `pgid`, or empty.
///
/// `/proc/<pid>/comm` is the kernel's own short name — the executable, no path
/// and no arguments, capped at 15 bytes. That is exactly what a tab wants, and
/// it is why this reads `comm` rather than parsing `cmdline`: a tag that said
/// `deno run -A --unstable-kv src/app.ts` would be a tag nobody can read, and
/// trimming that back down to `deno` is guessing at what the kernel already
/// knows.
///
/// The process group id IS the group leader's pid, which is the command the
/// shell put in the foreground. Best effort: the process can exit between the
/// `tcgetpgrp` and this read, and an empty name simply means the light is on
/// with nothing to label it.
fn comm_of(pgid: c_int) -> String {
    if pgid <= 0 {
        return String::new();
    }
    match std::fs::read_to_string(format!("/proc/{pgid}/comm")) {
        Ok(text) => text.trim_end_matches('\n').to_string(),
        Err(_) => String::new(),
    }
}

/// Turn a `waitpid` status into the number a shell would report.
fn wait_code(status: c_int) -> i32 {
    // WIFEXITED / WEXITSTATUS / WTERMSIG, spelled out — they are macros in C
    // and there is nothing to link against.
    if status & 0x7f == 0 {
        (status >> 8) & 0xff
    } else {
        128 + (status & 0x7f)
    }
}

/// Decode as many whole frames as `buf` holds, and act on each.
///
/// Returns `false` when the stream is unusable — a length no sane caller would
/// send means the two sides have lost sync, and guessing where the next frame
/// starts would write somebody's keystrokes into a resize.
fn consume(buf: &mut Vec<u8>, master: c_int) -> bool {
    let mut at = 0usize;
    while buf.len() - at >= 5 {
        let kind = buf[at];
        let len = u32::from_be_bytes([buf[at + 1], buf[at + 2], buf[at + 3], buf[at + 4]]) as usize;
        if len > 1 << 24 {
            return false;
        }
        if buf.len() - at - 5 < len {
            break;
        }
        let body = &buf[at + 5..at + 5 + len];
        match kind {
            IN_DATA => write_all(master, body),
            IN_RESIZE if len == 4 => {
                let size = Winsize {
                    ws_row: u16::from_be_bytes([body[0], body[1]]),
                    ws_col: u16::from_be_bytes([body[2], body[3]]),
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                // The kernel sends SIGWINCH to the foreground group for us,
                // which is how `vim` learns the window changed.
                unsafe { ioctl(master, TIOCSWINSZ, &size) };
            }
            _ => {}
        }
        at += 5 + len;
    }
    buf.drain(..at);
    true
}

/// Write every byte, or give up when the terminal is gone.
fn write_all(fd: c_int, mut body: &[u8]) {
    while !body.is_empty() {
        let n = unsafe { write(fd, body.as_ptr() as *const c_void, body.len()) };
        if n > 0 {
            body = &body[n as usize..];
            continue;
        }
        if n < 0 && errno() == EINTR {
            continue;
        }
        return;
    }
}
