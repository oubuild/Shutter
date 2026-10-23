//! Scroll-wheel injection and user-wheel listening (macOS only).
//!
//! Same CoreGraphics calls the reference app makes:
//! * `CGEventCreateScrollWheelEvent2` + `CGEventPost` for auto-scroll
//!   (reference `screen::auto_scroll` / `spawn_auto_scroll_worker`);
//! * `CGEventTapCreate` ListenOnly for intercepting the user's real wheel
//!   (reference `screen::start_scroll_listener_macos`) — manual scrolling
//!   pauses the session instead of fighting the injector.

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

#[cfg(target_os = "macos")]
pub mod imp {
    use super::InjectCapability;
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CallbackResult, CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType, EventField, ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A posted event carries the "event source state id" of its source; our
    /// injected events use HIDSystemState just like real hardware, so the
    /// discriminator is a timestamp window recorded at post time.
    static LAST_INJECTED_AT_MS: AtomicI64 = AtomicI64::new(0);

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

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

    /// Post one scroll-wheel step of `lines` lines at the current pointer
    /// location (reference: `CGEventCreateScrollWheelEvent2` + `CGEventPost`).
    /// Returns false when event creation failed (`创建滚动事件失败`).
    pub fn post_scroll(lines: i32) -> bool {
        let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
            log::warn!("[长截图] 创建事件源失败");
            return false;
        };
        let Ok(event) = CGEvent::new_scroll_event(
            source,
            ScrollEventUnit::LINE,
            1,
            lines,
            0,
            0,
        ) else {
            log::warn!("[长截图] 创建滚动事件失败");
            return false;
        };
        LAST_INJECTED_AT_MS.store(now_ms(), Ordering::SeqCst);
        event.post(CGEventTapLocation::HID);
        true
    }

    /// Was an injected event posted within the last `window_ms`?
    fn just_injected(window_ms: i64) -> bool {
        let at = LAST_INJECTED_AT_MS.load(Ordering::SeqCst);
        at != 0 && now_ms() - at <= window_ms
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
        /// Start a ListenOnly tap on ScrollWheel events.
        ///
        /// Injected events (posted within a few ms by us) are ignored; only
        /// genuine user wheel motion accumulates. Returns `None` when the tap
        /// cannot be created (degrades to no manual-pause detection).
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
                            CGEventTapOptions::ListenOnly,
                            vec![CGEventType::ScrollWheel],
                            |_proxy, _etype, event: &CGEvent| {
                                // Our own injections arrive within a few ms of
                                // the post; treat those as noise.
                                if just_injected(8) {
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
            Some(Self {
                shared,
                thread,
            })
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
