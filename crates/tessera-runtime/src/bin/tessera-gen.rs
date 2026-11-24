use std::path::PathBuf;
use std::process::ExitCode;

use tessera_runtime::r#gen;

fn main() -> ExitCode {
    let mut check = false;
    let mut out: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--check" => check = true,
            "--out" => match args.next() {
                Some(dir) => out = Some(PathBuf::from(dir)),
                None => {
                    eprintln!("--out needs a directory");
                    return ExitCode::from(2);
                }
            },
            "-h" | "--help" => {
                println!("usage: tessera-gen [--check] [--out DIR]");
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown argument {other}; usage: tessera-gen [--check] [--out DIR]");
                return ExitCode::from(2);
            }
        }
    }
    let dir = out.unwrap_or_else(r#gen::default_out_dir);
    let result = if check {
        r#gen::check(&dir)
    } else {
        r#gen::write(&dir)
    };
    match result {
        Ok(s) if check && !s.is_fresh() => {
            eprintln!(
                "stale TypeScript bindings in {}:\n  missing: {:?}\n  changed: {:?}\n  extra:   {:?}\nrun: bun run gen",
                dir.display(),
                s.missing,
                s.changed,
                s.extra
            );
            ExitCode::FAILURE
        }
        Ok(s) => {
            if check {
                println!("bindings in {} are up to date", dir.display());
            } else {
                println!(
                    "wrote {}: {} new, {} changed, {} removed",
                    dir.display(),
                    s.missing.len(),
                    s.changed.len(),
                    s.extra.len()
                );
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("tessera-gen: {e}");
            ExitCode::FAILURE
        }
    }
}
