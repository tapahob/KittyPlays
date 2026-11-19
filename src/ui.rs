//! Native Windows launcher dialog.

use crate::playback::Mode;
use std::cell::{OnceCell, RefCell};
use std::io;
use std::mem;
use std::ptr;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;

type Handle = isize;
type DialogProc = unsafe extern "system" fn(Handle, u32, usize, isize) -> isize;
type TimerProc = unsafe extern "system" fn(Handle, u32, usize, u32);

const ID_PLAY: u16 = 1; // IDOK is the dialog's default command.
const ID_CANCEL: u16 = 2;
const ID_SOURCE: u16 = 100;
const ID_BROWSE: u16 = 101;
const ID_GPU: u16 = 102;
const ID_MOTION: u16 = 103;
const ID_NATIVE: u16 = 104;

const WS_POPUP: u32 = 0x8000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CAPTION: u32 = 0x00c0_0000;
const WS_SYSMENU: u32 = 0x0008_0000;
const WS_GROUP: u32 = 0x0002_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const WS_EX_CLIENTEDGE: u32 = 0x0000_0200;
const DS_SETFONT: u32 = 0x40;
const DS_MODALFRAME: u32 = 0x80;
const DS_CENTER: u32 = 0x0800;
const ES_AUTOHSCROLL: u32 = 0x0080;
const BS_DEFPUSHBUTTON: u32 = 0x0001;
const BS_GROUPBOX: u32 = 0x0007;
const BS_AUTORADIOBUTTON: u32 = 0x0009;

const GWLP_USERDATA: i32 = -21;
const WM_CLOSE: u32 = 0x0010;
const WM_SETFONT: u32 = 0x0030;
const WM_GETFONT: u32 = 0x0031;
const WM_INITDIALOG: u32 = 0x0110;
const WM_COMMAND: u32 = 0x0111;
const WM_TIMER: u32 = 0x0113;
const DM_SETDEFID: u32 = 0x0401;
const BM_GETCHECK: u32 = 0x00f0;
const BM_SETCHECK: u32 = 0x00f1;
const BST_CHECKED: usize = 1;
const PLAYBACK_TIMER: usize = 1;
const MB_ICONERROR: u32 = 0x10;

const OFN_HIDEREADONLY: u32 = 0x0004;
const OFN_NOCHANGEDIR: u32 = 0x0008;
const OFN_PATHMUSTEXIST: u32 = 0x0800;
const OFN_FILEMUSTEXIST: u32 = 0x1000;
const OFN_EXPLORER: u32 = 0x0008_0000;

// A standard indirect dialog template with no menu, default dialog class,
// and no embedded controls. With DS_SETFONT it ends with the point size and face.
#[repr(C)]
struct DialogTemplate {
    style: u32,
    ex_style: u32,
    item_count: u16,
    x: i16,
    y: i16,
    width: i16,
    height: i16,
    menu: u16,
    class: u16,
    title: [u16; 11],
    font_size: u16,
    font_name: [u16; 9],
}

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct OpenFileName {
    size: u32,
    owner: Handle,
    instance: Handle,
    filter: *const u16,
    custom_filter: *mut u16,
    max_custom_filter: u32,
    filter_index: u32,
    file: *mut u16,
    max_file: u32,
    file_title: *mut u16,
    max_file_title: u32,
    initial_dir: *const u16,
    title: *const u16,
    flags: u32,
    file_offset: u16,
    file_extension: u16,
    default_extension: *const u16,
    custom_data: isize,
    hook: Option<unsafe extern "system" fn(Handle, u32, usize, isize) -> usize>,
    template_name: *const u16,
    reserved: *mut std::ffi::c_void,
    reserved_flags: u32,
    flags_ex: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn DialogBoxIndirectParamW(
        instance: Handle,
        template: *const DialogTemplate,
        owner: Handle,
        proc: DialogProc,
        param: isize,
    ) -> isize;
    fn EndDialog(dialog: Handle, result: isize) -> i32;
    fn MapDialogRect(dialog: Handle, rect: *mut Rect) -> i32;
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Handle,
        menu: Handle,
        instance: Handle,
        param: *const std::ffi::c_void,
    ) -> Handle;
    #[cfg_attr(target_pointer_width = "32", link_name = "SetWindowLongW")]
    fn SetWindowLongPtrW(window: Handle, index: i32, value: isize) -> isize;
    #[cfg_attr(target_pointer_width = "32", link_name = "GetWindowLongW")]
    fn GetWindowLongPtrW(window: Handle, index: i32) -> isize;
    fn GetWindowTextLengthW(window: Handle) -> i32;
    fn GetWindowTextW(window: Handle, text: *mut u16, count: i32) -> i32;
    fn SetWindowTextW(window: Handle, text: *const u16) -> i32;
    fn SendMessageW(window: Handle, message: u32, wparam: usize, lparam: isize) -> isize;
    fn SetFocus(window: Handle) -> Handle;
    fn EnableWindow(window: Handle, enable: i32) -> i32;
    fn SetTimer(window: Handle, id: usize, interval_ms: u32, callback: Option<TimerProc>) -> usize;
    fn KillTimer(window: Handle, id: usize) -> i32;
    fn MessageBoxW(owner: Handle, text: *const u16, title: *const u16, flags: u32) -> i32;
}

#[link(name = "comdlg32")]
unsafe extern "system" {
    fn GetOpenFileNameW(file: *mut OpenFileName) -> i32;
    fn CommDlgExtendedError() -> u32;
}

#[derive(Default)]
struct State {
    controls: OnceCell<Controls>,
    setup_error: OnceCell<String>,
    playback: RefCell<Option<Receiver<Result<(), String>>>>,
}

struct Controls {
    source: Handle,
    motion: Handle,
    native: Handle,
    play: Handle,
    status: Handle,
}

/// Show the launcher on this thread and return when its window closes.
pub fn run() -> Result<(), String> {
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    if instance == 0 {
        return Err(system_error("Не удалось получить дескриптор приложения"));
    }
    let mut template = DialogTemplate {
        style: WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_MODALFRAME | DS_SETFONT | DS_CENTER,
        ex_style: 0,
        item_count: 0,
        x: 0,
        y: 0,
        width: 285,
        height: 141,
        menu: 0,
        class: 0,
        title: [0; 11],
        font_size: 9,
        font_name: [0; 9],
    };
    for (unit, value) in template.title.iter_mut().zip("KittyPlays".encode_utf16()) {
        *unit = value;
    }
    for (unit, value) in template.font_name.iter_mut().zip("Segoe UI".encode_utf16()) {
        *unit = value;
    }

    let state = State::default();
    // The modal call keeps the template and UI-thread state alive for every callback.
    let result = unsafe {
        DialogBoxIndirectParamW(
            instance,
            &template,
            0,
            dialog_proc,
            ptr::from_ref(&state) as isize,
        )
    };
    if result == -1 {
        return Err(system_error("Не удалось открыть окно KittyPlays"));
    }
    state.setup_error.into_inner().map_or(Ok(()), Err)
}

unsafe extern "system" fn dialog_proc(
    dialog: Handle,
    message: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    if message == WM_INITDIALOG {
        let state = unsafe { &*(lparam as *const State) };
        unsafe { SetWindowLongPtrW(dialog, GWLP_USERDATA, lparam) };
        match create_controls(dialog) {
            Ok(controls) => {
                let source = controls.source;
                let _ = state.controls.set(controls);
                unsafe {
                    SendMessageW(dialog, DM_SETDEFID, ID_PLAY.into(), 0);
                    SetFocus(source);
                }
            }
            Err(error) => {
                let _ = state.setup_error.set(error);
                unsafe { EndDialog(dialog, 0) };
            }
        }
        return 0;
    }

    if message == WM_CLOSE {
        unsafe { EndDialog(dialog, 0) };
        return 1;
    }
    if message != WM_COMMAND && message != WM_TIMER {
        return 0;
    }

    let state = unsafe { GetWindowLongPtrW(dialog, GWLP_USERDATA) } as *const State;
    let Some(state) = (unsafe { state.as_ref() }) else {
        return 0;
    };
    let Some(controls) = state.controls.get() else {
        return 0;
    };

    match message {
        WM_COMMAND if (wparam >> 16) & 0xffff == 0 => match wparam as u16 {
            ID_CANCEL => unsafe {
                EndDialog(dialog, 0);
            },
            ID_BROWSE => {
                if let Err(error) = browse(dialog, controls.source) {
                    show_error(dialog, &error);
                }
            }
            ID_PLAY => {
                if let Err(error) = start_playback(dialog, controls, state) {
                    show_error(dialog, &error);
                }
            }
            _ => return 0,
        },
        WM_TIMER if wparam == PLAYBACK_TIMER => finish_playback(dialog, controls, state),
        _ => return 0,
    }
    1
}

fn create_controls(dialog: Handle) -> Result<Controls, String> {
    let font = unsafe { SendMessageW(dialog, WM_GETFONT, 0, 0) } as usize;
    let add =
        |class: &str, label: &str, style, ex_style, id: u16, [x, y, width, height]: [i32; 4]| {
            let mut rect = Rect {
                left: x,
                top: y,
                right: x + width,
                bottom: y + height,
            };
            let class = wide(class);
            let label = wide(label);
            let window = unsafe {
                if MapDialogRect(dialog, &mut rect) == 0 {
                    return Err(system_error("Не удалось рассчитать размеры окна"));
                }
                CreateWindowExW(
                    ex_style,
                    class.as_ptr(),
                    label.as_ptr(),
                    WS_CHILD | WS_VISIBLE | style,
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    dialog,
                    id as isize,
                    0,
                    ptr::null(),
                )
            };
            if window == 0 {
                return Err(system_error("Не удалось создать элемент окна"));
            }
            unsafe { SendMessageW(window, WM_SETFONT, font, 0) };
            Ok(window)
        };

    add(
        "STATIC",
        "&Адрес YouTube или путь к файлу",
        WS_GROUP,
        0,
        0,
        [12, 10, 261, 11],
    )?;
    let source = add(
        "EDIT",
        "",
        ES_AUTOHSCROLL | WS_TABSTOP,
        WS_EX_CLIENTEDGE,
        ID_SOURCE,
        [12, 24, 199, 15],
    )?;
    add(
        "BUTTON",
        "&Обзор…",
        WS_TABSTOP,
        0,
        ID_BROWSE,
        [217, 23, 56, 17],
    )?;
    add(
        "BUTTON",
        "Режим воспроизведения",
        BS_GROUPBOX,
        0,
        0,
        [12, 48, 261, 58],
    )?;
    let gpu = add(
        "BUTTON",
        "&Видеокарта — смешивание кадров, 120 кадров/с",
        BS_AUTORADIOBUTTON | WS_GROUP | WS_TABSTOP,
        0,
        ID_GPU,
        [21, 60, 242, 12],
    )?;
    let motion = add(
        "BUTTON",
        "&Процессор — компенсация движения, 120 кадров/с",
        BS_AUTORADIOBUTTON,
        0,
        ID_MOTION,
        [21, 74, 242, 12],
    )?;
    let native = add(
        "BUTTON",
        "&Исходная частота кадров",
        BS_AUTORADIOBUTTON,
        0,
        ID_NATIVE,
        [21, 88, 242, 12],
    )?;
    let status = add("STATIC", "", WS_GROUP, 0, 0, [12, 116, 172, 14])?;
    let play = add(
        "BUTTON",
        "&Воспроизвести",
        BS_DEFPUSHBUTTON | WS_TABSTOP,
        0,
        ID_PLAY,
        [190, 113, 83, 18],
    )?;
    unsafe { SendMessageW(gpu, BM_SETCHECK, BST_CHECKED, 0) };

    Ok(Controls {
        source,
        motion,
        native,
        play,
        status,
    })
}

fn browse(dialog: Handle, source: Handle) -> Result<(), String> {
    let filters = wide("Видеофайлы\0*.mp4;*.mkv;*.webm;*.mov;*.avi;*.m4v;*.wmv;*.mpeg;*.mpg;*.ts\0Все файлы\0*.*\0");
    let title = wide("Выберите видеофайл");
    let mut file = vec![0u16; 32_768];
    let mut request = OpenFileName {
        size: mem::size_of::<OpenFileName>() as u32,
        owner: dialog,
        filter: filters.as_ptr(),
        filter_index: 1,
        file: file.as_mut_ptr(),
        max_file: file.len() as u32,
        title: title.as_ptr(),
        flags: OFN_EXPLORER
            | OFN_HIDEREADONLY
            | OFN_NOCHANGEDIR
            | OFN_PATHMUSTEXIST
            | OFN_FILEMUSTEXIST,
        // The remaining optional parameters are null or zero.
        ..unsafe { mem::zeroed() }
    };
    unsafe {
        if GetOpenFileNameW(&mut request) != 0 {
            if SetWindowTextW(source, file.as_ptr()) == 0 {
                return Err(system_error("Не удалось вставить путь к файлу"));
            }
            SetFocus(source);
        } else {
            let error = CommDlgExtendedError();
            if error != 0 {
                return Err(format!(
                    "Не удалось выбрать файл. Код Windows: 0x{error:04X}."
                ));
            }
        }
    }
    Ok(())
}

fn start_playback(dialog: Handle, controls: &Controls, state: &State) -> Result<(), String> {
    if state.playback.borrow().is_some() {
        return Ok(());
    }

    let capacity = unsafe { GetWindowTextLengthW(controls.source) }.saturating_add(1);
    let mut buffer = vec![0u16; capacity as usize];
    let length = unsafe { GetWindowTextW(controls.source, buffer.as_mut_ptr(), capacity) };
    let source = String::from_utf16(&buffer[..length as usize])
        .map_err(|_| "В адресе или пути есть недопустимый символ Unicode.".to_owned())?;
    if source.trim().is_empty() {
        unsafe { SetFocus(controls.source) };
        return Err("Введите ссылку на YouTube или выберите видеофайл.".into());
    }

    let mode = unsafe {
        if SendMessageW(controls.motion, BM_GETCHECK, 0, 0) == BST_CHECKED as isize {
            Mode::Motion
        } else if SendMessageW(controls.native, BM_GETCHECK, 0, 0) == BST_CHECKED as isize {
            Mode::Native
        } else {
            Mode::Gpu
        }
    };

    // Poll the worker from the dialog thread, which owns every window handle.
    if unsafe { SetTimer(dialog, PLAYBACK_TIMER, 75, None) } == 0 {
        return Err(system_error(
            "Не удалось начать отслеживание воспроизведения",
        ));
    }
    let (sender, receiver) = mpsc::channel();
    if let Err(error) = thread::Builder::new()
        .name("kittyplays-playback".into())
        .spawn(move || {
            let _ = sender.send(crate::launch(source.trim(), mode));
        })
    {
        unsafe { KillTimer(dialog, PLAYBACK_TIMER) };
        return Err(format!("Не удалось запустить воспроизведение. {error}"));
    }
    state.playback.replace(Some(receiver));
    unsafe {
        EnableWindow(controls.play, 0);
        SetFocus(controls.source);
    }
    set_text(controls.status, "Воспроизведение…");
    Ok(())
}

fn finish_playback(dialog: Handle, controls: &Controls, state: &State) {
    let result = {
        let playback = state.playback.borrow();
        let Some(receiver) = playback.as_ref() else {
            return;
        };
        match receiver.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => {
                Err("Поток воспроизведения завершился неожиданно.".into())
            }
        }
    };
    state.playback.replace(None);
    unsafe {
        KillTimer(dialog, PLAYBACK_TIMER);
        EnableWindow(controls.play, 1);
    }
    match result {
        Ok(()) => set_text(controls.status, "Воспроизведение завершено."),
        Err(error) => {
            set_text(controls.status, "Ошибка воспроизведения.");
            show_error(dialog, &error);
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn set_text(window: Handle, text: &str) {
    unsafe { SetWindowTextW(window, wide(text).as_ptr()) };
}

fn show_error(dialog: Handle, error: &str) {
    let title = wide("KittyPlays");
    let message = wide(error);
    unsafe { MessageBoxW(dialog, message.as_ptr(), title.as_ptr(), MB_ICONERROR) };
}

fn system_error(context: &str) -> String {
    format!("{context}. {}", io::Error::last_os_error())
}
