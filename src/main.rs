#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    if let Err(error) = kittyplays::ui::run() {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(hwnd: isize, message: *const u16, title: *const u16, flags: u32) -> i32;
        }
        let message: Vec<_> = error.encode_utf16().chain(Some(0)).collect();
        let title: Vec<_> = "KittyPlays".encode_utf16().chain(Some(0)).collect();
        unsafe { MessageBoxW(0, message.as_ptr(), title.as_ptr(), 0x10) };
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Для консольного запуска используйте kittyplays-cli.");
    std::process::exit(1);
}
