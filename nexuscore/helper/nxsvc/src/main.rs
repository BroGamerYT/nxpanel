//! nxsvc - Dienst-Hülle für NexusCore.
//!
//!     nxsvc service [--name <Dienstname>] [--workdir <Ordner>] [--log <Datei>] [--grace <Sekunden>] -- <programm> [argumente...]
//!     nxsvc run     [--workdir <Ordner>] [--log <Datei>] [--grace <Sekunden>] [--stop-on-stdin-eof] -- <programm> [argumente...]
//!
//! * `service`: läuft als Windows-Dienst (Dienststeuerung, "Beenden" und "Herunterfahren" kommen an).
//! * `run`: dieselbe Überwachung in der Konsole (Strg+C beendet) - zum Ausprobieren ohne Dienst.
//!
//! Die Hülle startet das Programm (den Core) mit `NEXUSCORE_SERVICE=1` und einem Stdin-Rohr. Beenden heißt:
//! das Rohr schließen. Der Core versteht das als "sauber beenden" (Spiele stoppen, Daten sichern); erst wenn er
//! nach `--grace` Sekunden (Standard 100) noch läuft, wird er hart beendet.
//!
//! Stürzt das Programm ab oder endet es von selbst, startet die Hülle es neu: nach 2 Sekunden, bei Wiederholung
//! mit verdoppelter Wartezeit bis 60 Sekunden; lief es länger als eine Minute, beginnt die Wartezeit von vorn.
//! Ausgabe und Fehler des Programms landen in der Protokolldatei (ab 10 MB wird sie zu `<Datei>.1`).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static STOP: AtomicBool = AtomicBool::new(false);
static OPTIONS: OnceLock<Options> = OnceLock::new();

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const FIRST_DELAY: Duration = Duration::from_secs(2);
const MAX_DELAY: Duration = Duration::from_secs(60);
const STABLE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Options {
    mode: Mode,
    name: String,
    workdir: Option<PathBuf>,
    log: Option<PathBuf>,
    grace: Duration,
    /// Nur fuer `run`: beenden, sobald das eigene Stdin geschlossen wird (Tests, Skripte).
    stop_on_stdin_eof: bool,
    program: String,
    args: Vec<String>,
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Mode {
    Service,
    Run,
}

fn parse(args: Vec<String>) -> Result<Options, String> {
    let mut it = args.into_iter();
    let mode = match it.next().as_deref() {
        Some("service") => Mode::Service,
        Some("run") => Mode::Run,
        _ => return Err("Erster Parameter muss 'service' oder 'run' sein.".into()),
    };
    let mut o = Options {
        mode,
        name: "NexusCore".into(),
        workdir: None,
        log: None,
        grace: Duration::from_secs(100),
        stop_on_stdin_eof: false,
        program: String::new(),
        args: Vec::new(),
    };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--name" => o.name = it.next().ok_or("--name braucht einen Wert")?,
            "--workdir" => o.workdir = Some(it.next().ok_or("--workdir braucht einen Wert")?.into()),
            "--log" => o.log = Some(it.next().ok_or("--log braucht einen Wert")?.into()),
            "--stop-on-stdin-eof" => o.stop_on_stdin_eof = true,
            "--grace" => {
                let s: u64 = it.next().ok_or("--grace braucht einen Wert")?.parse().map_err(|_| "--grace: ungültige Zahl")?;
                if !(1..=3600).contains(&s) {
                    return Err("--grace: erlaubt sind 1 bis 3600 Sekunden".into());
                }
                o.grace = Duration::from_secs(s);
            }
            "--" => {
                o.program = it.next().ok_or("Nach -- fehlt das Programm")?;
                o.args = it.collect();
                break;
            }
            other => return Err(format!("Unbekannter Parameter: {other}")),
        }
    }
    if o.program.is_empty() {
        return Err("Es fehlt das Programm (nach --).".into());
    }
    Ok(o)
}

// ------------------------------------------------------------------ Protokoll

fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Sekunden seit 1970 (UTC) - lesbar genug und ohne Zeitbibliothek eindeutig
    format!("{secs}")
}

fn open_log(path: &Option<PathBuf>) -> Option<File> {
    let path = path.as_ref()?;
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::metadata(path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let mut old = path.clone().into_os_string();
        old.push(".1");
        let _ = fs::remove_file(&old);
        let _ = fs::rename(path, &old);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn note(log: &mut Option<File>, message: &str) {
    let line = format!("[nxsvc {}] {message}\n", stamp());
    match log {
        Some(f) => {
            let _ = f.write_all(line.as_bytes());
        }
        None => eprint!("{line}"),
    }
}

// --------------------------------------------------------------- Überwachung

fn nap(total: Duration) {
    let end = Instant::now() + total;
    while Instant::now() < end && !STOP.load(Ordering::SeqCst) {
        sleep(Duration::from_millis(100));
    }
}

fn spawn(o: &Options, log: &mut Option<File>) -> std::io::Result<Child> {
    let mut cmd = Command::new(&o.program);
    cmd.args(&o.args).env("NEXUSCORE_SERVICE", "1").stdin(Stdio::piped());
    if let Some(dir) = &o.workdir {
        cmd.current_dir(dir);
    }
    match log.as_ref().and_then(|f| f.try_clone().ok()) {
        Some(out) => {
            let err = out.try_clone()?;
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        None => {
            cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        }
    }
    cmd.spawn()
}

/// Rohr schließen = "sauber beenden"; nach der Frist hart beenden.
fn stop_child(child: &mut Child, grace: Duration, log: &mut Option<File>) {
    note(log, "Beenden: das Programm wird gebeten, sauber zu enden");
    drop(child.stdin.take());
    let end = Instant::now() + grace;
    while Instant::now() < end {
        match child.try_wait() {
            Ok(Some(status)) => {
                note(log, &format!("Programm beendet ({status})"));
                return;
            }
            Ok(None) => sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    note(log, "Das Programm hat nicht rechtzeitig geendet und wird hart beendet");
    let _ = child.kill();
    let _ = child.wait();
}

fn supervise(o: &Options) {
    let mut delay = FIRST_DELAY;
    while !STOP.load(Ordering::SeqCst) {
        let mut log = open_log(&o.log);
        let mut child = match spawn(o, &mut log) {
            Ok(c) => c,
            Err(e) => {
                note(&mut log, &format!("Programm konnte nicht gestartet werden: {e} - neuer Versuch in {} s", delay.as_secs()));
                drop(log);
                nap(delay);
                delay = (delay * 2).min(MAX_DELAY);
                continue;
            }
        };
        note(&mut log, &format!("Programm gestartet (PID {})", child.id()));
        let started = Instant::now();
        loop {
            if STOP.load(Ordering::SeqCst) {
                stop_child(&mut child, o.grace, &mut log);
                return;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    note(&mut log, &format!("Programm hat sich beendet ({status})"));
                    break;
                }
                Ok(None) => sleep(Duration::from_millis(200)),
                Err(e) => {
                    note(&mut log, &format!("Programm nicht mehr abfragbar: {e}"));
                    let _ = child.kill();
                    break;
                }
            }
        }
        if started.elapsed() > STABLE_AFTER {
            delay = FIRST_DELAY;
        }
        note(&mut log, &format!("Neustart in {} s", delay.as_secs()));
        drop(log);
        nap(delay);
        delay = (delay * 2).min(MAX_DELAY);
    }
}

// ------------------------------------------------------------------- Windows

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::AtomicPtr;

    type Handle = *mut c_void;

    const SERVICE_WIN32_OWN_PROCESS: u32 = 0x10;
    const SERVICE_STOPPED: u32 = 1;
    const SERVICE_START_PENDING: u32 = 2;
    const SERVICE_STOP_PENDING: u32 = 3;
    const SERVICE_RUNNING: u32 = 4;
    const SERVICE_ACCEPT_STOP: u32 = 0x1;
    const SERVICE_ACCEPT_PRESHUTDOWN: u32 = 0x100;
    const SERVICE_CONTROL_STOP: u32 = 1;
    const SERVICE_CONTROL_INTERROGATE: u32 = 4;
    const SERVICE_CONTROL_SHUTDOWN: u32 = 5;
    const SERVICE_CONTROL_PRESHUTDOWN: u32 = 0xF;

    #[repr(C)]
    struct ServiceStatus {
        service_type: u32,
        current_state: u32,
        controls_accepted: u32,
        win32_exit_code: u32,
        service_specific_exit_code: u32,
        check_point: u32,
        wait_hint: u32,
    }

    #[repr(C)]
    struct ServiceTableEntry {
        name: *const u16,
        proc_: Option<unsafe extern "system" fn(u32, *mut *mut u16)>,
    }

    type HandlerEx = unsafe extern "system" fn(u32, u32, *mut c_void, *mut c_void) -> u32;
    type ConsoleHandler = unsafe extern "system" fn(u32) -> i32;

    #[link(name = "advapi32")]
    extern "system" {
        fn StartServiceCtrlDispatcherW(table: *const ServiceTableEntry) -> i32;
        fn RegisterServiceCtrlHandlerExW(name: *const u16, handler: HandlerEx, context: *mut c_void) -> Handle;
        fn SetServiceStatus(handle: Handle, status: *const ServiceStatus) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: ConsoleHandler, add: i32) -> i32;
        fn GetLastError() -> u32;
    }

    static STATUS_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn report(state: u32, wait_hint: u32) {
        let handle = STATUS_HANDLE.load(Ordering::SeqCst);
        if handle.is_null() {
            return;
        }
        let accepted = if state == SERVICE_RUNNING { SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_PRESHUTDOWN } else { 0 };
        let status = ServiceStatus {
            service_type: SERVICE_WIN32_OWN_PROCESS,
            current_state: state,
            controls_accepted: accepted,
            win32_exit_code: 0,
            service_specific_exit_code: 0,
            check_point: 0,
            wait_hint,
        };
        unsafe {
            SetServiceStatus(handle, &status);
        }
    }

    unsafe extern "system" fn handler(control: u32, _event: u32, _data: *mut c_void, _ctx: *mut c_void) -> u32 {
        match control {
            SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN | SERVICE_CONTROL_PRESHUTDOWN => {
                let grace = OPTIONS.get().map(|o| o.grace.as_millis() as u32).unwrap_or(100_000);
                report(SERVICE_STOP_PENDING, grace.saturating_add(20_000));
                STOP.store(true, Ordering::SeqCst);
            }
            SERVICE_CONTROL_INTERROGATE => {}
            _ => {}
        }
        0
    }

    unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
        let o = OPTIONS.get().expect("Optionen fehlen");
        let name = wide(&o.name);
        let handle = RegisterServiceCtrlHandlerExW(name.as_ptr(), handler, std::ptr::null_mut());
        if handle.is_null() {
            return;
        }
        STATUS_HANDLE.store(handle, Ordering::SeqCst);
        report(SERVICE_START_PENDING, 10_000);
        report(SERVICE_RUNNING, 0);
        supervise(o);
        report(SERVICE_STOPPED, 0);
    }

    pub fn run_service() -> i32 {
        let o = OPTIONS.get().expect("Optionen fehlen");
        let name = wide(&o.name);
        let table = [
            ServiceTableEntry { name: name.as_ptr(), proc_: Some(service_main) },
            ServiceTableEntry { name: std::ptr::null(), proc_: None },
        ];
        unsafe {
            if StartServiceCtrlDispatcherW(table.as_ptr()) == 0 {
                // 1063 = nicht von der Dienststeuerung gestartet
                let code = GetLastError();
                eprintln!("[nxsvc] Dienst konnte nicht starten (Fehler {code}). 'service' geht nur über die Dienststeuerung - zum Ausprobieren 'run' benutzen.");
                return 5;
            }
        }
        0
    }

    unsafe extern "system" fn console_handler(_kind: u32) -> i32 {
        STOP.store(true, Ordering::SeqCst);
        1
    }

    pub fn install_console_handler() {
        unsafe {
            SetConsoleCtrlHandler(console_handler, 1);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse(args) {
        Ok(o) => o,
        Err(message) => {
            eprintln!("[nxsvc] {message}");
            eprintln!("Aufruf: nxsvc <service|run> [--name N] [--workdir D] [--log F] [--grace S] -- <programm> [argumente...]");
            std::process::exit(2);
        }
    };
    let mode = options.mode;
    let _ = OPTIONS.set(options);
    let o = OPTIONS.get().unwrap();
    match mode {
        Mode::Run => {
            #[cfg(windows)]
            win::install_console_handler();
            if o.stop_on_stdin_eof {
                std::thread::spawn(|| {
                    let mut sink = Vec::new();
                    let _ = std::io::Read::read_to_end(&mut std::io::stdin(), &mut sink);
                    STOP.store(true, Ordering::SeqCst);
                });
            }
            supervise(o);
        }
        Mode::Service => {
            #[cfg(windows)]
            std::process::exit(win::run_service());
            #[cfg(not(windows))]
            {
                eprintln!("[nxsvc] Dienste gibt es nur unter Windows.");
                std::process::exit(2);
            }
        }
    }
}
