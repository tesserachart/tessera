use std::process::ExitCode;

fn main() -> ExitCode {
    tessera_runtime::cli::main(tessera_runtime::cli::Launch::default())
}
