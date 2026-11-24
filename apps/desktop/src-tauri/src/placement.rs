use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

const FILL: f64 = 0.94;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn place(area: Rect, scale: f64, preferred: (f64, f64), minimum: (f64, f64)) -> Rect {
    let side = |preferred: f64, minimum: f64, available: u32| -> u32 {
        let available = f64::from(available);
        let fitted = (preferred * scale).min(available * FILL);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let size = fitted.max(minimum * scale).min(available).round() as u32;
        size
    };
    let width = side(preferred.0, minimum.0, area.width);
    let height = side(preferred.1, minimum.1, area.height);
    let offset = |available: u32, size: u32| i32::try_from((available - size) / 2).unwrap_or(0);
    Rect {
        x: area.x + offset(area.width, width),
        y: area.y + offset(area.height, height),
        width,
        height,
    }
}

pub fn fit_and_show<R: Runtime>(
    window: &WebviewWindow<R>,
    preferred: (f64, f64),
    minimum: (f64, f64),
) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let work = monitor.work_area();
        let area = Rect {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        };
        let frame = place(area, monitor.scale_factor(), preferred, minimum);
        let _ = window.set_size(PhysicalSize::new(frame.width, frame.height));
        let _ = window.set_position(PhysicalPosition::new(frame.x, frame.y));
    }
    let _ = window.show();
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFERRED: (f64, f64) = (1600.0, 1000.0);
    const MINIMUM: (f64, f64) = (1100.0, 680.0);

    #[test]
    fn keeps_the_configured_size_centered_on_a_large_screen() {
        let area = Rect {
            x: 0,
            y: 50,
            width: 5120,
            height: 2830,
        };
        assert_eq!(
            place(area, 2.0, PREFERRED, MINIMUM),
            Rect {
                x: 960,
                y: 465,
                width: 3200,
                height: 2000
            }
        );
    }

    #[test]
    fn shrinks_to_fit_a_laptop_screen() {
        let area = Rect {
            x: 0,
            y: 66,
            width: 3024,
            height: 1898,
        };
        let frame = place(area, 2.0, PREFERRED, MINIMUM);
        assert_eq!(
            frame,
            Rect {
                x: 90,
                y: 123,
                width: 2843,
                height: 1784
            }
        );
        assert!(frame.x >= area.x && frame.x + i32::try_from(frame.width).unwrap() <= 3024);
    }

    #[test]
    fn never_exceeds_a_screen_smaller_than_the_minimum() {
        let area = Rect {
            x: 100,
            y: 0,
            width: 1024,
            height: 600,
        };
        assert_eq!(
            place(area, 1.0, PREFERRED, MINIMUM),
            Rect {
                x: 100,
                y: 0,
                width: 1024,
                height: 600
            }
        );
    }
}
