//! cargo identifies a workspace member's build by its path relative to the workspace root, so two
//! checkouts that share one `CARGO_TARGET_DIR` can be handed each other's binary, or a mix of both
//! checkouts' crates.

use std::path::{Path, PathBuf};

pub const EXIT_OTHER_CHECKOUT: u8 = 4;

pub const EXPECT_CHECKOUT_ENV: &str = "TESSERA_EXPECT_CHECKOUT";

fn checkout_of(manifest_dir: &str) -> PathBuf {
    let dir = Path::new(manifest_dir);
    dir.parent()
        .and_then(Path::parent)
        .unwrap_or(dir)
        .to_path_buf()
}

pub fn build_checkouts(bin_manifest_dir: &str) -> Vec<PathBuf> {
    let mut out = vec![checkout_of(bin_manifest_dir)];
    let lib = checkout_of(env!("CARGO_MANIFEST_DIR"));
    if !out.contains(&lib) {
        out.push(lib);
    }
    out
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

pub fn check(expected: &Path, built: &[PathBuf]) -> Result<(), String> {
    match built.iter().find(|b| !same_dir(b, expected)) {
        None => Ok(()),
        Some(other) => Err(format!(
            "this binary was built from the checkout {}, not from {} ({EXPECT_CHECKOUT_ENV}). The \
             two checkouts share a cargo target directory (CARGO_TARGET_DIR), and cargo reused the \
             other checkout's build. Give each checkout its own target directory (unset \
             CARGO_TARGET_DIR, or set a different one per checkout), then build again",
            other.display(),
            expected.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binary_from_another_checkout_is_named() {
        let here = checkout_of(env!("CARGO_MANIFEST_DIR"));
        assert!(here.join("Cargo.toml").is_file(), "{}", here.display());
        assert_eq!(
            build_checkouts(env!("CARGO_MANIFEST_DIR")),
            vec![here.clone()]
        );
        assert!(check(&here, std::slice::from_ref(&here)).is_ok());
        assert!(check(&here.join("crates/.."), std::slice::from_ref(&here)).is_ok());
        let other = Path::new("/elsewhere/tessera-wt/feature");
        let err = check(&here, &[here.clone(), other.to_path_buf()]).unwrap_err();
        assert!(err.contains("/elsewhere/tessera-wt/feature"), "{err}");
        assert!(err.contains("CARGO_TARGET_DIR"), "{err}");
        assert_eq!(
            checkout_of("/w/feature/crates/tessera-runtime"),
            Path::new("/w/feature")
        );
    }
}
