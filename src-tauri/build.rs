use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    // WinLibs GCC appends its own manifest object in the endfile rule. Keep its
    // CRT options but omit that object: Tauri embeds our complete manifest.
    if env::var("TARGET").is_ok_and(|target| target.ends_with("windows-gnu")) {
        let linker = env::var_os("RUSTC_LINKER").unwrap_or_else(|| "gcc".into());
        if let Ok(output) = Command::new(linker).arg("-dumpspecs").output() {
            let specs = String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n");
            if let Some(rule) = specs
                .split("\n\n")
                .find_map(|section| section.strip_prefix("*endfile:\n"))
            {
                let default_manifest = "%{!shared:%:if-exists(default-manifest.o%s)}";
                if rule.contains(default_manifest) {
                    let path =
                        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("kanban-endfile.specs");
                    fs::write(
                        &path,
                        format!("*endfile:\n{}\n\n", rule.replace(default_manifest, "")),
                    )
                    .expect("write local GCC resource override");
                    println!("cargo:rustc-link-arg=-specs={}", path.display());
                }
            }
        }
    }
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let version = format!(
        "{}.{}.{}.0",
        env::var("CARGO_PKG_VERSION_MAJOR").unwrap(),
        env::var("CARGO_PKG_VERSION_MINOR").unwrap(),
        env::var("CARGO_PKG_VERSION_PATCH").unwrap()
    );
    let manifest = include_str!("windows-app.manifest").replace("@APP_VERSION@", &version);
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(manifest)),
    )
    .expect("build desktop resources");
}
