#![cfg(windows)]
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn conpty_has_a_console_accepts_stdin_and_preserves_exit_status() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_touri"))
        .args(["--provider-login-pty", "--", "powershell.exe", "-NoLogo", "-NoProfile", "-Command",
            "if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { exit 91 }; $code = [Console]::ReadLine(); [Console]::WriteLine('fixture-reply:' + $code); exit 7"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().unwrap();
    let mut output = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        output.read_to_string(&mut text).unwrap();
        text
    });
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"browser-code-fixture\r\n")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            let text = reader.join().unwrap();
            panic!("ConPTY fixture did not finish; output: {text:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(7));
    assert!(reader
        .join()
        .unwrap()
        .contains("fixture-reply:browser-code-fixture"));
}
