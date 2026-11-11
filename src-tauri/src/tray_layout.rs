//! Bounded logical-pixel sizing signals accepted only from the bundled tray.

pub(crate) const DEFAULT_WIDTH: u32 = 328;
pub(crate) const MAX_WIDTH: u32 = 480;
pub(crate) const MAX_HEIGHT: u32 = 900;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Size {
    pub width: u32,
    pub height: u32,
}

impl Size {
    /// Natural content size, never a viewport-relative or arbitrary command.
    pub(crate) fn from_action(action: &str) -> Option<Self> {
        let (width, height) = action.strip_prefix("resize-")?.split_once('-')?;
        fn dimension(value: &str) -> Option<u32> {
            if value.len() != 3 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            value.parse().ok()
        }
        let size = Self {
            width: dimension(width)?,
            height: dimension(height)?,
        };
        ((280..=MAX_WIDTH).contains(&size.width) && (160..=MAX_HEIGHT).contains(&size.height))
            .then_some(size)
    }

    /// Monitor work area is already in logical pixels (DPI conversion is native).
    pub(crate) fn fit(self, available: Self) -> Self {
        Self {
            width: self.width.min(available.width.max(1)),
            height: self.height.min(available.height.max(1)),
        }
    }

    pub(crate) fn from_work_area(width: u32, height: u32, scale: f64) -> Option<Self> {
        if !scale.is_finite() || scale <= 0.0 || width == 0 || height == 0 {
            return None;
        }
        Some(Self {
            width: ((f64::from(width) / scale).floor() as u32).clamp(1, MAX_WIDTH),
            height: ((f64::from(height) / scale).floor() as u32).clamp(1, MAX_HEIGHT),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_integer_content_sizes() {
        for (action, width, height) in [
            ("resize-328-417", 328, 417),
            ("resize-280-160", 280, 160),
            ("resize-480-900", 480, 900),
        ] {
            assert_eq!(Size::from_action(action), Some(Size { width, height }));
        }
    }

    #[test]
    fn rejects_malformed_and_unbounded_signals() {
        for action in [
            "resize-279-400",
            "resize-481-400",
            "resize-328-159",
            "resize-328-901",
            "resize-328-0",
            "resize-0328-400",
            "resize-328-0400",
            "resize-328-400-extra",
            "resize--328-400",
            "resize-328--400",
            "resize-328.0-400",
            "resize-3e2-400",
            "resize-NaN-400",
            "resize-∞-400",
            "resize-328-400\n",
            "resize-328-400/",
            "resize-328-400?x",
            "resize-328-400#x",
            "resize-328-9999999999999999999",
            "show",
            "resize",
            "resize-",
            "resize-328",
            "RESIZE-328-400",
        ] {
            assert_eq!(Size::from_action(action), None, "{action:?}");
        }
    }

    #[test]
    fn work_area_conversion_floors_fractional_dpi_and_never_exceeds_screen() {
        assert_eq!(
            Size::from_work_area(1920, 1040, 1.25),
            Some(Size {
                width: 480,
                height: 832
            })
        );
        assert_eq!(
            Size::from_work_area(640, 479, 1.5),
            Some(Size {
                width: 426,
                height: 319
            })
        );
        let natural = Size {
            width: 328,
            height: 600,
        };
        assert_eq!(
            natural.fit(Size {
                width: 426,
                height: 319
            }),
            Size {
                width: 328,
                height: 319
            }
        );
        assert_eq!(
            natural.fit(Size {
                width: 480,
                height: 900
            }),
            natural
        );
        assert_eq!(
            natural.fit(Size {
                width: 200,
                height: 150
            }),
            Size {
                width: 200,
                height: 150
            }
        );
    }

    #[test]
    fn invalid_monitor_metadata_is_not_used() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(Size::from_work_area(1920, 1080, scale), None);
        }
        assert_eq!(Size::from_work_area(0, 1080, 1.0), None);
        assert_eq!(Size::from_work_area(1920, 0, 1.0), None);
    }
}
