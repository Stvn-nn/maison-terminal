//! Maison Terminal desktop shell.
//!
//! The shell owns only the window. The Python analytical service (python-core) runs as its
//! own process on 127.0.0.1:8000; the web UI connects to it directly and recovers when the
//! service starts late, so this binary never spawns or terminates Python.

use tauri::{LogicalSize, Manager, WebviewWindow};

const PREFERRED_LOGICAL_WIDTH: f64 = 1360.0;
const PREFERRED_LOGICAL_HEIGHT: f64 = 860.0;
const MINIMUM_LOGICAL_WIDTH: f64 = 960.0;
const MINIMUM_LOGICAL_HEIGHT: f64 = 640.0;
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
    tauri::Builder::default()
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(sizing_error) = fit_window_to_work_area(&main_window) {
                    eprintln!("Could not fit the window to the work area: {sizing_error}");
                }
                // The window starts hidden (see tauri.conf.json) to avoid a resize flash.
                main_window.show()?;
                main_window.set_focus()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Maison Terminal failed to start");
}
