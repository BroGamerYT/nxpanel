//! nxjob - startet ein Programm in einem Windows-Job-Object.
//!
//!     nxjob [--mem-mb <MB>] [--cpu-rate <1..10000>] -- <programm> [argumente...]
//!
//! * Das Programm läuft in einem Job Object mit `KILL_ON_JOB_CLOSE`: Endet nxjob (auch hart, auch wenn der
//!   Core abstürzt), beendet Windows alle Prozesse des Spiels. Es bleibt keine Waise zurück.
//! * `--mem-mb`: harte Grenze für den zugesagten Speicher je Prozess (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`).
//! * `--cpu-rate`: harte CPU-Obergrenze für alle Prozesse des Jobs, in Hundertstel Prozent der GESAMTEN
//!   Rechenleistung (10000 = alle Kerne, 2500 = ein Viertel).
//! * Ein-/Ausgabe und Umgebung werden unverändert an das Programm weitergegeben, der Exit-Code kommt zurück.
//!
//! Kann die Grenze nicht gesetzt werden, startet das Programm NICHT (Exit-Code 3): eine zugesagte Grenze, die
//! still fehlt, ist schlimmer als ein Fehler.

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};

    type Handle = *mut c_void;

    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION_CLASS: i32 = 15;
    const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE: u32 = 0x1;
    const JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP: u32 = 0x4;

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct CpuRateControlInformation {
        control_flags: u32,
        cpu_rate: u32,
    }

    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    pub struct Options {
        pub mem_mb: Option<u64>,
        pub cpu_rate: Option<u32>,
        pub program: String,
        pub args: Vec<String>,
    }

    pub fn parse(args: Vec<String>) -> Result<Options, String> {
        let mut mem_mb = None;
        let mut cpu_rate = None;
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--mem-mb" => {
                    let v = it.next().ok_or("--mem-mb braucht einen Wert")?;
                    let n: u64 = v.parse().map_err(|_| format!("--mem-mb: \"{v}\" ist keine Zahl"))?;
                    if n == 0 || n > 4 * 1024 * 1024 {
                        return Err(format!("--mem-mb: {n} ist nicht sinnvoll (1 bis 4194304)"));
                    }
                    mem_mb = Some(n);
                }
                "--cpu-rate" => {
                    let v = it.next().ok_or("--cpu-rate braucht einen Wert")?;
                    let n: u32 = v.parse().map_err(|_| format!("--cpu-rate: \"{v}\" ist keine Zahl"))?;
                    if !(1..=10000).contains(&n) {
                        return Err(format!("--cpu-rate: {n} liegt nicht zwischen 1 und 10000"));
                    }
                    cpu_rate = Some(n);
                }
                "--" => {
                    let program = it.next().ok_or("nach -- fehlt das Programm")?;
                    return Ok(Options { mem_mb, cpu_rate, program, args: it.collect() });
                }
                other => return Err(format!("unbekannte Option: {other}")),
            }
        }
        Err("nach den Optionen muss -- und das Programm folgen".to_string())
    }

    pub fn run(o: Options) -> i32 {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                eprintln!("[nxjob] Job Object konnte nicht angelegt werden (Fehler {})", GetLastError());
                return 3;
            }

            let mut limits = ExtendedLimitInformation::default();
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(mb) = o.mem_mb {
                limits.basic.limit_flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                limits.process_memory_limit = (mb as usize).saturating_mul(1024 * 1024);
            }
            if SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                &mut limits as *mut _ as *mut c_void,
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            ) == 0
            {
                eprintln!("[nxjob] Speichergrenze konnte nicht gesetzt werden (Fehler {})", GetLastError());
                return 3;
            }

            if let Some(rate) = o.cpu_rate {
                let mut cpu = CpuRateControlInformation {
                    control_flags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    cpu_rate: rate,
                };
                if SetInformationJobObject(
                    job,
                    JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION_CLASS,
                    &mut cpu as *mut _ as *mut c_void,
                    std::mem::size_of::<CpuRateControlInformation>() as u32,
                ) == 0
                {
                    eprintln!("[nxjob] CPU-Grenze konnte nicht gesetzt werden (Fehler {})", GetLastError());
                    return 3;
                }
            }

            let mut child = match Command::new(&o.program)
                .args(&o.args)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[nxjob] Programm konnte nicht gestartet werden: {e}");
                    return 4;
                }
            };

            if AssignProcessToJobObject(job, child.as_raw_handle() as Handle) == 0 {
                let code = GetLastError();
                let _ = child.kill();
                eprintln!("[nxjob] Programm konnte nicht in das Job Object gelegt werden (Fehler {code})");
                return 3;
            }

            match child.wait() {
                Ok(status) => status.code().unwrap_or(1),
                Err(e) => {
                    eprintln!("[nxjob] Warten auf das Programm fehlgeschlagen: {e}");
                    1
                }
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match win::parse(args) {
        Ok(options) => std::process::exit(win::run(options)),
        Err(message) => {
            eprintln!("[nxjob] {message}");
            eprintln!("Aufruf: nxjob [--mem-mb <MB>] [--cpu-rate <1..10000>] -- <programm> [argumente...]");
            std::process::exit(2);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("[nxjob] Job Objects gibt es nur unter Windows.");
    std::process::exit(2);
}
