//! OS drop target for the dock window.
//!
//! Registers an OLE IDropTarget on the dock toplevel window and all child
//! windows (including WebView2 render widgets). This allows external OS drags
//! (such as files dragged from File Explorer) to be accepted with DROPEFFECT_COPY
//! (preventing the prohibited/blocked cursor) and emits drag events so that
//! spring-loaded app hovering can dwell and activate the hovered app's window.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, Ref, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{CoInitializeEx, IDataObject, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, DROPEFFECT, DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

pub static DOCK_OLE_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

struct TargetStore(#[allow(dead_code)] Vec<IDropTarget>);
unsafe impl Send for TargetStore {}

static DOCK_DROP_TARGETS: Mutex<Option<TargetStore>> = Mutex::new(None);

#[implement(IDropTarget)]
struct DockDropTarget {
    app: AppHandle,
    top_hwnd: HWND,
    enter_valid: UnsafeCell<bool>,
}

impl DockDropTarget {
    unsafe fn client_point(&self, pt: &POINTL) -> POINT {
        let mut point = POINT { x: pt.x, y: pt.y };
        let _ = ScreenToClient(self.top_hwnd, &mut point);
        point
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DockDropTarget_Impl {
    fn DragEnter(
        &self,
        _pdata: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        DOCK_OLE_DRAG_ACTIVE.store(true, Ordering::Relaxed);
        unsafe {
            *self.enter_valid.get() = true;
            *effect = DROPEFFECT_COPY;
        }
        let point = unsafe { self.client_point(pt) };
        let _ = self.app.emit(
            "dock-drag-enter",
            serde_json::json!({ "position": { "x": point.x, "y": point.y } }),
        );
        Ok(())
    }

    fn DragOver(
        &self,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        DOCK_OLE_DRAG_ACTIVE.store(true, Ordering::Relaxed);
        unsafe { *effect = DROPEFFECT_COPY };
        let point = unsafe { self.client_point(pt) };
        let _ = self.app.emit(
            "dock-drag-over",
            serde_json::json!({ "position": { "x": point.x, "y": point.y } }),
        );
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        DOCK_OLE_DRAG_ACTIVE.store(false, Ordering::Relaxed);
        if unsafe { *self.enter_valid.get() } {
            unsafe { *self.enter_valid.get() = false };
            let _ = self.app.emit("dock-drag-leave", ());
        }
        Ok(())
    }

    fn Drop(
        &self,
        _pdata: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        DOCK_OLE_DRAG_ACTIVE.store(false, Ordering::Relaxed);
        if unsafe { *self.enter_valid.get() } {
            unsafe {
                *self.enter_valid.get() = false;
                *effect = DROPEFFECT_COPY;
            }
            let point = unsafe { self.client_point(pt) };
            let _ = self.app.emit(
                "dock-drag-drop",
                serde_json::json!({ "position": { "x": point.x, "y": point.y } }),
            );
        }
        Ok(())
    }
}

pub fn setup(app: &AppHandle) {
    let Some(win) = app.get_webview_window("dock") else {
        return;
    };
    let Ok(hwnd) = win.hwnd() else {
        return;
    };

    struct Ctx {
        app: AppHandle,
        top_hwnd: HWND,
        targets: Vec<IDropTarget>,
    }

    unsafe extern "system" fn child_proc(child: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        unsafe { inject(child, ctx.top_hwnd, &ctx.app, &mut ctx.targets) };
        BOOL(1)
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let mut ctx = Ctx {
            app: app.clone(),
            top_hwnd: hwnd,
            targets: Vec::new(),
        };
        inject(hwnd, hwnd, app, &mut ctx.targets);
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(child_proc),
            LPARAM(&mut ctx as *mut Ctx as isize),
        );
        if let Ok(mut guard) = DOCK_DROP_TARGETS.lock() {
            *guard = Some(TargetStore(ctx.targets));
        }
    }
}

unsafe fn inject(hwnd: HWND, top_hwnd: HWND, app: &AppHandle, out: &mut Vec<IDropTarget>) {
    let target: IDropTarget = DockDropTarget {
        app: app.clone(),
        top_hwnd,
        enter_valid: UnsafeCell::new(false),
    }
    .into();
    let _ = unsafe { RevokeDragDrop(hwnd) };
    if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
        out.push(target);
    }
}

