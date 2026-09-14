fn main() {
    // MinGW GNU 工具链:rustc 会把所有 rlib 符号导出到 cdylib,超出 PE 65535
    // ordinal 上限(报 "export ordinal too large")。排除内部符号即可;
    // MSVC link.exe 无此问题,故仅对 (windows, gnu) 生效。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo::rustc-link-arg=-Wl,--exclude-libs=ALL,--exclude-all-symbols");
    }
    tauri_build::build()
}
