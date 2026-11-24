use std::fmt;

use serde_json::Value;
use tessera_protocol::tools::{ToolErrorCode, ToolErrorInfo};

#[derive(Debug, Clone, PartialEq)]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
    pub details: Option<Value>,
    pub retryable: bool,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message: impl Into<String>) -> Self {
        let retryable = matches!(
            code,
            ToolErrorCode::Unavailable | ToolErrorCode::RateLimited | ToolErrorCode::Timeout
        );
        Self {
            code,
            message: message.into(),
            details: None,
            retryable,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::InvalidInput, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::NotFound, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::Unavailable, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::Unsupported, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::Conflict, message)
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::PermissionDenied, message)
    }

    pub fn outcome_unknown(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::OutcomeUnknown, message)
    }

    pub fn rejected(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::Rejected, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ToolErrorCode::Internal, message)
    }

    pub fn to_info(&self) -> ToolErrorInfo {
        ToolErrorInfo {
            code: self.code,
            message: self.message.clone(),
            details: self.details.clone(),
            retryable: self.retryable,
        }
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolError {}

impl From<serde_json::Error> for ToolError {
    fn from(e: serde_json::Error) -> Self {
        ToolError::invalid_input(e.to_string())
    }
}

impl From<tessera_store::StoreError> for ToolError {
    fn from(e: tessera_store::StoreError) -> Self {
        ToolError::internal(format!("the store: {e}"))
    }
}

impl From<ToolError> for ToolErrorInfo {
    fn from(e: ToolError) -> Self {
        e.to_info()
    }
}
