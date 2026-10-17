use std::fs;
use std::path::PathBuf;

fn main() {
    // `tauri_build` validates external binaries even for `cargo check`. A tiny local
    // placeholder keeps the unsigned scaffold checkable; `bun run build:sidecar`
    // replaces it with the compiled sidecar before a dev/build run.
    let target = std::env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".to_string());
    let binary = PathBuf::from("binaries").join(format!(
        "touri-sidecar-{target}{}",
        if target.contains("windows") {
            ".exe"
        } else {
            ""
        }
    ));
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && fs::metadata(&binary).map_or(true, |m| m.len() < 10_000)
    {
        panic!("Compile the target sidecar with bun run build:sidecar before packaging");
    }
    if !binary.exists() {
        let _ = fs::create_dir_all("binaries");
        let _ = fs::write(&binary, b"#!/bin/sh\nexit 0\n");
    }
    if target.contains("apple-darwin") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    println!("cargo:rerun-if-changed=build.rs");
    if target.contains("windows-msvc") {
        // Test binaries never get Tauri's app manifest, so comctl32 v6 entry points
        // (e.g. TaskDialogIndirect) are missing and the test harness fails to start.
        // Embed one manifest for every binary instead.
        let manifest = std::env::current_dir()
            .expect("build script cwd")
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        println!("cargo:rustc-link-arg=/WX");
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("tauri build");
        return;
    }
    tauri_build::build()
}
