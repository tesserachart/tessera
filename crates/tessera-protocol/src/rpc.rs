use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const JSONRPC_VERSION: &str = "2.0";

/// A request id: number or string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    /// Numeric id (a JSON number; JavaScript clients use safe integers).
    Number(#[ts(type = "number")] i64),
    /// String id.
    String(String),
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => f.write_str(s),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<RequestId>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub params: Option<Value>,
}

impl RpcRequest {
    pub fn new(id: RequestId, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: Some(id),
            method: method.into(),
            params: Some(params),
        }
    }
}

/// An error object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct RpcError {
    /// Error code (see [`codes`]).
    pub code: i32,
    /// Human-readable message.
    pub message: String,
    /// Structured detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rpc error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

pub mod codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const UNAUTHORIZED: i32 = -32001;
    pub const FORBIDDEN: i32 = -32002;
    pub const UNKNOWN_TOPIC: i32 = -32003;
    pub const NOT_FOUND: i32 = -32004;
    pub const PREVIEW_HASH_MISMATCH: i32 = -32010;
    pub const STALE: i32 = -32011;
    pub const ALREADY_RESOLVED: i32 = -32012;
    pub const CONFLICT: i32 = -32013;
    pub const UNSUPPORTED: i32 = -32014;
    pub const UNAVAILABLE: i32 = -32015;
    pub const SHUTTING_DOWN: i32 = -32020;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: Option<RequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: Option<RequestId>, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Option<RequestId>, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub topic: String,
    #[ts(type = "number")]
    pub seq: u64,
    pub subscription_id: String,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct EventNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: EventEnvelope,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_and_response_shapes() {
        let req: RpcRequest = serde_json::from_value(
            json!({"jsonrpc":"2.0","id":7,"method":"tools.list","params":{}}),
        )
        .unwrap();
        assert_eq!(req.id, Some(RequestId::Number(7)));
        let note: RpcRequest =
            serde_json::from_value(json!({"jsonrpc":"2.0","method":"x"})).unwrap();
        assert!(note.id.is_none() && note.params.is_none());
        let ok =
            serde_json::to_value(RpcResponse::ok(Some(RequestId::Number(1)), json!([1]))).unwrap();
        assert_eq!(ok, json!({"jsonrpc":"2.0","id":1,"result":[1]}));
        let err = serde_json::to_value(RpcResponse::err(
            Some(RequestId::String("a".into())),
            RpcError::new(codes::METHOD_NOT_FOUND, "nope"),
        ))
        .unwrap();
        assert_eq!(
            err,
            json!({"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"nope"}})
        );
    }
}
