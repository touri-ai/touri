#![cfg(windows)]
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn native_lock_is_exclusive_and_releases_on_stdin_eof() {
    let root = std::env::temp_dir().join(format!("touri-lock-interface-{}", std::process::id()));
    let request = format!(
        "{}\n",
        serde_json::json!({ "op": "lock", "root": root, "path": root.join("run/runtime.lock") })
    );
    let start = || {
        let mut child = Command::new(env!("CARGO_BIN_EXE_touri"))
            .arg("--native-lock")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(request.as_bytes())
            .unwrap();
        child
    };
    let mut first = start();
    let stdout = first.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = send.send(line);
    });
    let ready = receive.recv_timeout(Duration::from_secs(20));
    if ready.is_err() {
        let _ = first.kill();
        let _ = first.wait();
        panic!("native lock handshake timed out");
    }
    assert_eq!(ready.unwrap().trim(), "locked");
    let mut second = start();
    drop(second.stdin.take());
    assert!(!second.wait_with_output().unwrap().status.success());
    drop(first.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    while first.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            let _ = first.kill();
            let _ = first.wait();
            panic!("lock helper did not retire on EOF");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut third = start();
    drop(third.stdin.take());
    let output = third.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "locked");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn killing_the_stdio_helper_terminates_its_process_tree() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    let root = std::env::temp_dir().join(format!("touri-job-interface-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let marker = root.join("child-pid.txt");
    let path = marker.to_string_lossy().replace('\'', "''");
    let script = format!("$child = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; [IO.File]::WriteAllText('{path}', [string]$child.Id); Start-Sleep -Seconds 60");
    let mut helper = Command::new(env!("CARGO_BIN_EXE_touri"))
        .args([
            "--spawn-tree",
            "--",
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let pid: u32 = loop {
        if let Ok(text) = std::fs::read_to_string(&marker) {
            if let Ok(pid) = text.parse() {
                break pid;
            }
        }
        if Instant::now() > deadline {
            let _ = helper.kill();
            let _ = helper.wait();
            panic!("job fixture did not start");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    let child = unsafe { OwnedHandle::from_raw_handle(handle) };
    let identity = Command::new(env!("CARGO_BIN_EXE_touri"))
        .args(["--process-identity", &helper.id().to_string()])
        .output()
        .unwrap();
    assert!(identity.status.success());
    let identity: serde_json::Value = serde_json::from_slice(&identity.stdout).unwrap();
    assert_eq!(identity["value"]["alive"], true);
    let birth = identity["value"]["birth"].as_str().unwrap();
    let terminate = |expected: &str| {
        let result = Command::new(env!("CARGO_BIN_EXE_touri"))
            .args(["--terminate-process", &helper.id().to_string(), expected])
            .output()
            .unwrap();
        assert!(result.status.success());
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()["value"].clone()
    };
    assert_eq!(terminate("different birth"), false);
    assert!(helper.try_wait().unwrap().is_none());
    assert_eq!(terminate(birth), true);
    helper.wait().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle(), 10_000) },
        WAIT_OBJECT_0
    );
    std::fs::remove_dir_all(root).unwrap();
}
