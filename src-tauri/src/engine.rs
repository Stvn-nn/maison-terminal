//! Lifecycle of the analytical engine (python-core, packaged with PyInstaller and shipped
//! inside the installer as `maison-core/maison-core.exe`).
//!
//! - On launch: if a healthy engine already answers on 127.0.0.1:8000 (for example
//!   `python main.py` during development, or a previous app instance), it is reused and
//!   never touched. Otherwise the bundled engine is started without a console window.
//! - On exit: only an engine this app started is stopped.
//! - The engine's working directory is the app's config folder, so a `.env` file there can
//!   provide `FINNHUB_API_KEY`. Its output goes to `maison-core.log` in the app's log folder.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Manager, Runtime};

const ENGINE_SOCKET_ADDRESS: ([u8; 4], u16) = ([127, 0, 0, 1], 8000);
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// `GET /health` returns `"service": "maison-terminal-core"`; anything else on the port is not ours.
const ENGINE_SERVICE_MARKER: &str = "maison-terminal-core";
const ENGINE_DIRECTORY_NAME: &str = "maison-core";
#[cfg(windows)]
const ENGINE_EXECUTABLE_NAME: &str = "maison-core.exe";
#[cfg(not(windows))]
const ENGINE_EXECUTABLE_NAME: &str = "maison-core";
const ENGINE_LOG_FILE_NAME: &str = "maison-core.log";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct EngineSupervisor {
    owned_engine: Mutex<Option<Child>>,
    is_shutting_down: AtomicBool,
}

impl EngineSupervisor {
    /// Reuse a running engine, or start the bundled one. Call from a background thread:
    /// the health probe can take up to its timeout when nothing is listening.
    pub fn start_if_needed<R: Runtime>(&self, app: &AppHandle<R>) {
        if engine_is_healthy() {
            println!("Analytical engine already running on 127.0.0.1:8000; reusing it");
            return;
        }
        let Some(engine_executable) = locate_bundled_engine(app) else {
            println!("No bundled analytical engine found; expecting one to be started separately");
            return;
        };
        match spawn_engine(app, &engine_executable) {
            Ok(mut engine_process) => {
                if self.is_shutting_down.load(Ordering::SeqCst) {
                    // The app began exiting while the engine was being started.
                    stop_process(&mut engine_process);
                    return;
                }
                if let Ok(mut owned_engine) = self.owned_engine.lock() {
                    *owned_engine = Some(engine_process);
                }
            }
            Err(spawn_error) => {
                eprintln!(
                    "Could not start the analytical engine at {engine_executable:?}: {spawn_error}"
                );
            }
        }
    }

    /// Stop the engine only if this app instance started it.
    pub fn stop_owned_engine(&self) {
        self.is_shutting_down.store(true, Ordering::SeqCst);
        let owned_engine = self
            .owned_engine
            .lock()
            .ok()
            .and_then(|mut owned_engine| owned_engine.take());
        if let Some(mut engine_process) = owned_engine {
            stop_process(&mut engine_process);
        }
    }
}

fn stop_process(engine_process: &mut Child) {
    let _ = engine_process.kill();
    let _ = engine_process.wait();
}

/// Minimal HTTP/1.0 probe of `GET /health` (avoids pulling an HTTP client into the shell).
fn engine_is_healthy() -> bool {
    let engine_address = SocketAddr::from(ENGINE_SOCKET_ADDRESS);
    let Ok(mut stream) = TcpStream::connect_timeout(&engine_address, HEALTH_PROBE_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(HEALTH_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_PROBE_TIMEOUT));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response_text = String::new();
    let _ = stream.take(16 * 1024).read_to_string(&mut response_text);
    let status_line = response_text.lines().next().unwrap_or_default();
    status_line.contains(" 200") && response_text.contains(ENGINE_SERVICE_MARKER)
}

fn locate_bundled_engine<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let resource_directory = app.path().resource_dir().ok()?;
    let engine_executable = resource_directory
        .join(ENGINE_DIRECTORY_NAME)
        .join(ENGINE_EXECUTABLE_NAME);
    engine_executable.is_file().then_some(engine_executable)
}

fn to_io_error(path_error: tauri::Error) -> std::io::Error {
    std::io::Error::other(path_error.to_string())
}

fn spawn_engine<R: Runtime>(app: &AppHandle<R>, engine_executable: &Path) -> std::io::Result<Child> {
    let working_directory = app.path().app_config_dir().map_err(to_io_error)?;
    fs::create_dir_all(&working_directory)?;
    let log_directory = app.path().app_log_dir().map_err(to_io_error)?;
    fs::create_dir_all(&log_directory)?;
    let log_file = File::create(log_directory.join(ENGINE_LOG_FILE_NAME))?;

    let mut engine_command = Command::new(engine_executable);
    engine_command
        .current_dir(&working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file));
    #[cfg(windows)]
    engine_command.creation_flags(CREATE_NO_WINDOW);
    engine_command.spawn()
}
