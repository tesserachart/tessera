use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("connection pool: {0}")]
    Pool(#[from] r2d2::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("migration {version}: {message}")]
    Migration { version: i64, message: String },
    #[error("conflict: expected revision {expected}, found {actual}")]
    Conflict { expected: i64, actual: i64 },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("blob {sha256} is corrupt: {reason}")]
    CorruptBlob { sha256: String, reason: String },
    #[error("invalid argument: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub(crate) fn io_err(path: impl Into<PathBuf>) -> impl FnOnce(std::io::Error) -> StoreError {
    let path = path.into();
    move |source| StoreError::Io { path, source }
}
