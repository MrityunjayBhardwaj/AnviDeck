fn main() {
    // Only the commands listed here exist for the window, and a capability must grant each (#239).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["write"])),
    )
    .expect("tauri build step failed");
}
