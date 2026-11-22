//! Maison Terminal desktop shell.
//!
//! The shell owns the window and the lifecycle of the bundled analytical engine
//! (see `engine.rs`). The web UI talks to the engine directly on 127.0.0.1:8000 and keeps
//! retrying until it answers, so a slow engine start never blocks the window.

mod engine;

use engine::EngineSupervisor;
use tauri::{LogicalSize, Manager, RunEvent, WebviewWindow};

const PREFERRED_LOGICAL_WIDTH: f64 = 1360.0;
const PREFERRED_LOGICAL_HEIGHT: f64 = 860.0;
const MINIMUM_LOGICAL_WIDTH: f64 = 420.0;
const MINIMUM_LOGICAL_HEIGHT: f64 = 320.0;
/// Leave a margin around the window on displays smaller than the preferred size.
const WORK_AREA_FILL_RATIO: f64 = 0.92;

/// Shrink the initial window to the monitor's work area (excluding the taskbar) on small
/// displays, so the frameless window never opens partly off-screen.
fn fit_window_to_work_area(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => monitor,
        None => match window.primary_monitor()? {
            Some(monitor) => monitor,
            None => return Ok(()),
        },
    };
    let work_area_size: LogicalSize<f64> = monitor.work_area().size.to_logical(monitor.scale_factor());
    let target_width = PREFERRED_LOGICAL_WIDTH.min(work_area_size.width * WORK_AREA_FILL_RATIO);
    let target_height = PREFERRED_LOGICAL_HEIGHT.min(work_area_size.height * WORK_AREA_FILL_RATIO);

    if target_width < MINIMUM_LOGICAL_WIDTH || target_height < MINIMUM_LOGICAL_HEIGHT {
        // Displays smaller than the minimum: relax the minimum so the window still fits.
        window.set_min_size(Some(LogicalSize::new(
            target_width.min(MINIMUM_LOGICAL_WIDTH),
            target_height.min(MINIMUM_LOGICAL_HEIGHT),
        )))?;
    }
    window.set_size(LogicalSize::new(target_width, target_height))?;
    window.center()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .manage(EngineSupervisor::default())
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(sizing_error) = fit_window_to_work_area(&main_window) {
                    eprintln!("Could not fit the window to the work area: {sizing_error}");
                }
                // The window starts hidden (see tauri.conf.json) to avoid a resize flash.
                main_window.show()?;
                main_window.set_focus()?;
            }
            // Start (or reuse) the engine off the main thread so the window appears at once.
            let engine_app_handle = app.handle().clone();
            std::thread::spawn(move || {
                engine_app_handle
                    .state::<EngineSupervisor>()
                    .start_if_needed(&engine_app_handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Maison Terminal failed to start");

    application.run(|app_handle, run_event| {
        if let RunEvent::Exit = run_event {
            app_handle.state::<EngineSupervisor>().stop_owned_engine();
        }
    });
}
