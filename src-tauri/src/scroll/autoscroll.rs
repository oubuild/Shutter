//! Scroll-wheel injection and user-wheel listening (macOS only).
//!
//! Same CoreGraphics calls the reference app makes:
//! * `CGEventCreateScrollWheelEvent2` + `CGEventPost` for auto-scroll
//!   (reference `screen::auto_scroll` / `spawn_auto_scroll_worker`);
//! * `CGEventTapCreate` for intercepting the user's real wheel
//!   (reference `screen::start_scroll_listener_macos`) — manual scrolling
//!   pauses the session instead of fighting the injector.
//!
//! Both ride on ONE permission: Accessibility. Since macOS Catalina a
//! ListenOnly tap is gated by the separate Input Monitoring TCC service
//! (which would prompt for a second permission), while an Active/Default
//! tap is gated by Accessibility — the same grant the injector needs. The
//! reference keeps listening and injection under Accessibility this way
//! (report §1.4); the callback never modifies events, so Active here is
//! functionally listen-only.

/// Result of trying to arm the auto-scroller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectCapability {
    /// Accessibility permission present; injection armed.
    Ok,
    /// No permission — the session runs in manual-scroll mode instead.
    NoPermission,
    /// Not macOS.
    Unsupported,
}

/// Scroll distance per injected step, in display points (reference
/// `auto_scroll`'s hardcoded `10.0`, confirmed by its runtime log
/// `macOS point_delta=-10.00 scale_factor=2.00 frame_expected=Some(20)` and
/// by `pixel_scroll`'s disassembly: `kCGScrollEventUnitPixel`, `wheel1 =
/// -delta`). POINT units — not LINES: a "line" is app-defined (Chrome maps one
/// to ~40px and animates it), so the step would be neither small nor
/// deterministic, while 10pt keeps consecutive overlaps pixel-identical (the
/// reference's verifier runs at mae=0.0 on every frame) and lets the pipeline
/// expect the offset: `expected_px = SCROLL_STEP_POINTS × scale_factor`.
pub const SCROLL_STEP_POINTS: i32 = 10;

#[cfg(target_os = "macos")]
pub mod imp {
    use super::InjectCapability;
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult, EventField, ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::Arc;

    /// The reference tags every injected scroll event with this sentinel in
    /// `kCGEventSourceUserData`-adjacent field 42 (`set_integer_value_field(ev,
    /// 42, 0x12345678)` in `pixel_scroll`), so its listener distinguishes
    /// injections from the user's real wheel by VALUE, not by post-time
    /// proximity — robust against delayed delivery and slow wheel callbacks.
    const INJECTED_EVENT_TAG: i64 = 0x1234_5678;
    /// `EventField::EVENT_SOURCE_USER_DATA` (= 42), spelled as its raw value
    /// because the crate's field constants are plain `u32`s, not the enum.
    const INJECTED_EVENT_TAG_FIELD: u32 = 42;

    // `kind = "framework"`: the plain dylib lookup fails because
    // ApplicationServices re-exports the symbol from HIServices; the framework
    // import path resolves it (verified with a C probe against the SDK).
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    /// Whether this process may synthesize input events (AXIsProcessTrusted).
    /// The reference logs `创建事件源失败` when this fails and falls back to
    /// asking the user to scroll manually.
    pub fn inject_capable() -> InjectCapability {
        if unsafe { AXIsProcessTrusted() } {
            InjectCapability::Ok
        } else {
            InjectCapability::NoPermission
        }
    }

    /// Post one scroll-wheel step of `points` display points at the current
    /// pointer location — a 1:1 port of the reference's `pixel_scroll`:
    /// `CGEventCreateScrollWheelEvent2(HIDSystemState, kCGScrollEventUnitPixel,
    /// 1, -points, 0, 0)`, tagged `INJECTED_EVENT_TAG`, posted to the HID tap.
    /// Returns false when event creation failed (`创建滚动事件失败`).
    ///
    /// `points` is positive for scrolling DOWN (revealing content below), the
    /// direction the stitcher expects (positive offset). macOS's `wheel1` sign
    /// is the opposite — a positive `wheel1` scrolls UP — so the sign is
    /// negated here; without it the page scrolls backwards and the pipeline
    /// sees a negative offset it rejects as 方向反转.
    ///
    /// Callers pass [`SCROLL_STEP_POINTS`]; the pipeline's expected offset is
    /// `SCROLL_STEP_POINTS × scale_factor` (reference `frame_expected`).
    pub fn post_scroll(points: i32) -> bool {
        let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
            log::warn!("[长截图] 创建事件源失败");
            return false;
        };
        let Ok(event) = CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 1, -points, 0, 0)
        else {
            log::warn!("[长截图] 创建滚动事件失败");
            return false;
        };
        event.set_integer_value_field(INJECTED_EVENT_TAG_FIELD, INJECTED_EVENT_TAG);
        event.post(CGEventTapLocation::HID);
        true
    }

    /// Shared listener state: the thread writes, the session drains.
    #[derive(Default)]
    struct ListenerShared {
        stop: AtomicBool,
        /// Net user scroll since the last drain, in wheel lines (neg = up).
        user_lines: AtomicI64,
    }

    /// Handle for the user-wheel listener thread (reference
    /// `ScrollListenerThreadGuard`).
    pub struct ScrollListener {
        shared: Arc<ListenerShared>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl ScrollListener {
        /// Start an Active tap on ScrollWheel events.
        ///
        /// Injected events (posted within a few ms by us) are ignored; only
        /// genuine user wheel motion accumulates. Returns `None` when the tap
        /// cannot be created (no Accessibility grant — degrades to no
        /// manual-pause detection; see the module comment for why Active and
        /// not ListenOnly).
        pub fn start() -> Option<Self> {
            let shared = Arc::new(ListenerShared::default());

            // CGEventTap::new_unchecked is unsafe for a reason: the callback
            // must live as long as the tap. Leak one Arc for 'static and keep
            // another in this handle so Drop can flip the stop flag.
            let leaked: &'static ListenerShared = Box::leak(Arc::clone(&shared).into());
            let thread = std::thread::Builder::new()
                .name("scroll-listener".into())
                .spawn(move || {
                    let tap = unsafe {
                        CGEventTap::new_unchecked(
                            CGEventTapLocation::Session,
                            CGEventTapPlacement::HeadInsertEventTap,
                            CGEventTapOptions::Default,
                            vec![CGEventType::ScrollWheel],
                            |_proxy, _etype, event: &CGEvent| {
                                // Injections carry the sentinel tag (reference
                                // parity); the user's real wheel never does.
                                if event.get_integer_value_field(INJECTED_EVENT_TAG_FIELD)
                                    == INJECTED_EVENT_TAG
                                {
                                    return CallbackResult::Keep;
                                }
                                let dy = event.get_integer_value_field(
                                    EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_1,
                                );
                                leaked.user_lines.fetch_add(dy, Ordering::SeqCst);
                                CallbackResult::Keep
                            },
                        )
                    };
                    let Ok(tap) = tap else {
                        log::warn!("[长截图] 滚动监听器初始化失败");
                        return;
                    };
                    let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                        log::warn!("[长截图] 滚动监听器初始化失败（runloop source）");
                        return;
                    };
                    let rl = CFRunLoop::get_current();
                    unsafe { rl.add_source(&source, kCFRunLoopCommonModes) };
                    tap.enable();
                    log::info!("[长截图] 滚动监听器初始化完成");
                    // Pump the run loop in short slices so the stop flag is
                    // checked promptly (CFRunLoop::run_current never returns).
                    loop {
                        unsafe {
                            CFRunLoop::run_in_mode(
                                kCFRunLoopCommonModes,
                                std::time::Duration::from_millis(200),
                                false,
                            )
                        };
                        if leaked.stop.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    log::info!("[长截图] 滚动监听器已停止");
                })
                .ok();
            if thread.is_none() {
                return None;
            }
            log::info!("[长截图] 滚动监听器启动");
            Some(Self { shared, thread })
        }

        /// Net user wheel lines since the previous drain.
        pub fn drain_user_lines(&self) -> i64 {
            self.shared.user_lines.swap(0, Ordering::SeqCst)
        }
    }

    impl Drop for ScrollListener {
        fn drop(&mut self) {
            log::info!("[长截图] 检测到关闭滚动监听");
            self.shared.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{inject_capable, post_scroll, ScrollListener};

/// Injection is unavailable on non-macOS: the session runs in manual mode.
#[cfg(not(target_os = "macos"))]
pub fn inject_capable() -> InjectCapability {
    InjectCapability::Unsupported
}

#[cfg(not(target_os = "macos"))]
pub fn post_scroll(_lines: i32) -> bool {
    false
}

/// Non-macOS listener stub: there is no CGEventTap equivalent wired here, so
/// manual-scroll pause detection is off and the session runs purely on timed
/// captures. `start` still succeeds so the session shape is identical across
/// platforms (the field is held, never drained).
#[cfg(not(target_os = "macos"))]
pub struct ScrollListener;

#[cfg(not(target_os = "macos"))]
impl ScrollListener {
    pub fn start() -> Option<Self> {
        log::info!("[长截图] 滚动监听器仅支持 macOS，本平台跳过");
        Some(Self)
    }

    /// Always zero: no user-wheel input is observed on this platform.
    pub fn drain_user_lines(&self) -> i64 {
        0
    }
}
