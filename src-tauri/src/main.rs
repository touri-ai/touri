#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if let Some(code) =
        touri_lib::platform::windows_files::entry(&std::env::args_os().skip(1).collect::<Vec<_>>())
    {
        std::process::exit(code);
    }
    if let Some(code) = touri_lib::provider_login_pty::entry(std::env::args_os().skip(1).collect())
    {
        std::process::exit(code);
    }
    touri_lib::run();
}
