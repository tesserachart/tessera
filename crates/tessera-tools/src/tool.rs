use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tessera_core::accounts::Environment;
use tessera_core::ids::{ApprovalId, CallId, DraftId, SessionId};
use tessera_core::{InstrumentId, Origin, Timestamp};
use tessera_protocol::tools::ToolDescriptor;

use crate::error::ToolError;
use crate::meta::ToolMeta;

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct ActionTarget {
    pub account: String,
    pub instrument: Option<InstrumentId>,
    pub environment: Option<Environment>,
    pub exit: bool,
}

#[derive(Clone, Default)]
pub struct Extensions {
    map: HashMap<TypeId, Arc<dyn Any + Send + Sync>>,
}

impl Extensions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert<T: Any + Send + Sync>(&mut self, value: Arc<T>) {
        self.map.insert(TypeId::of::<T>(), value);
    }

    pub fn get<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        self.map
            .get(&TypeId::of::<T>())
            .and_then(|v| v.clone().downcast::<T>().ok())
    }
}

impl std::fmt::Debug for Extensions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Extensions")
            .field("len", &self.map.len())
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct ToolCtx {
    pub call_id: CallId,
    pub origin: Origin,
    pub session_id: Option<SessionId>,
    pub idempotency_key: Option<String>,
    pub approved_by: Option<ApprovalId>,
    pub draft_id: Option<DraftId>,
    pub now: Timestamp,
    pub extensions: Extensions,
}

impl ToolCtx {
    pub fn new(origin: Origin, now: Timestamp) -> Self {
        Self {
            call_id: CallId::generate(),
            session_id: origin.session_id().cloned(),
            origin,
            idempotency_key: None,
            approved_by: None,
            draft_id: None,
            now,
            extensions: Extensions::default(),
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync + 'static {
    type Input: DeserializeOwned + Serialize + JsonSchema + Send + Sync;
    type Output: Serialize + JsonSchema + Send;

    fn meta(&self) -> ToolMeta;

    async fn call(&self, ctx: &ToolCtx, input: Self::Input) -> Result<Self::Output, ToolError>;

    async fn preview(&self, _ctx: &ToolCtx, input: &Self::Input) -> Result<Value, ToolError> {
        Ok(serde_json::to_value(input)?)
    }

    async fn ready(&self, _ctx: &ToolCtx, _input: &Self::Input) -> Result<(), ToolError> {
        Ok(())
    }

    async fn target(&self, _input: &Self::Input) -> Option<ActionTarget> {
        None
    }

    fn summarize(&self, _output: &Self::Output) -> Option<String> {
        None
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ErasedOutput {
    pub value: Value,
    pub summary: Option<String>,
}

#[async_trait]
pub trait DynTool: Send + Sync {
    fn meta(&self) -> &ToolMeta;
    fn descriptor(&self) -> &ToolDescriptor;
    fn validate(&self, input: &Value) -> Result<(), ToolError>;
    async fn call_json(&self, ctx: &ToolCtx, input: Value) -> Result<ErasedOutput, ToolError>;
    async fn preview_json(&self, ctx: &ToolCtx, input: &Value) -> Result<Value, ToolError>;
    async fn ready_json(&self, ctx: &ToolCtx, input: &Value) -> Result<(), ToolError>;
    async fn target_json(&self, input: &Value) -> Result<Option<ActionTarget>, ToolError>;
}

pub(crate) fn normalize_input(input: Value) -> Value {
    if input.is_null() {
        Value::Object(Default::default())
    } else {
        input
    }
}

fn decode<T: DeserializeOwned>(input: &Value) -> Result<T, ToolError> {
    T::deserialize(input).map_err(|e| ToolError::invalid_input(format!("invalid input: {e}")))
}

pub fn schema_for<T: JsonSchema>(for_input: bool) -> Value {
    let settings = SchemaSettings::draft2020_12().with(|s| {
        s.inline_subschemas = true;
    });
    let settings = if for_input {
        settings.for_deserialize()
    } else {
        settings.for_serialize()
    };
    let schema = settings.into_generator().into_root_schema_for::<T>();
    serde_json::to_value(schema).unwrap_or(Value::Null)
}

pub(crate) struct ToolBox<T: Tool> {
    tool: T,
    meta: ToolMeta,
    descriptor: ToolDescriptor,
}

impl<T: Tool> ToolBox<T> {
    pub(crate) fn new(tool: T) -> Self {
        let meta = tool.meta();
        let descriptor = ToolDescriptor {
            name: meta.name.clone(),
            mcp_name: meta.mcp_name(),
            title: meta.title.clone(),
            description: meta.description.clone(),
            risk: meta.risk,
            category: meta.category.clone(),
            input_schema: schema_for::<T::Input>(true),
            output_schema: schema_for::<T::Output>(false),
            ui_hints: meta.ui.clone(),
            idempotent: meta.idempotent,
            user_only: meta.user_only,
        };
        Self {
            tool,
            meta,
            descriptor,
        }
    }
}

#[async_trait]
impl<T: Tool> DynTool for ToolBox<T> {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn validate(&self, input: &Value) -> Result<(), ToolError> {
        decode::<T::Input>(input).map(|_| ())
    }

    async fn call_json(&self, ctx: &ToolCtx, input: Value) -> Result<ErasedOutput, ToolError> {
        let input: T::Input = decode(&input)?;
        let output = self.tool.call(ctx, input).await?;
        let summary = self.tool.summarize(&output);
        let value = serde_json::to_value(&output)
            .map_err(|e| ToolError::internal(format!("output serialization failed: {e}")))?;
        Ok(ErasedOutput { value, summary })
    }

    async fn preview_json(&self, ctx: &ToolCtx, input: &Value) -> Result<Value, ToolError> {
        let input: T::Input = decode(input)?;
        self.tool.preview(ctx, &input).await
    }

    async fn ready_json(&self, ctx: &ToolCtx, input: &Value) -> Result<(), ToolError> {
        let input: T::Input = decode(input)?;
        self.tool.ready(ctx, &input).await
    }

    async fn target_json(&self, input: &Value) -> Result<Option<ActionTarget>, ToolError> {
        let input: T::Input = decode(input)?;
        Ok(self.tool.target(&input).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_typed() {
        let mut e = Extensions::new();
        e.insert(Arc::new(42_u32));
        e.insert(Arc::new(String::from("svc")));
        assert_eq!(*e.get::<u32>().unwrap(), 42);
        assert_eq!(e.get::<String>().unwrap().as_str(), "svc");
        assert!(e.get::<i64>().is_none());
    }

    #[test]
    fn schemas_are_inlined() {
        #[derive(serde::Deserialize, Serialize, JsonSchema)]
        struct Inner {
            a: u32,
        }
        #[derive(serde::Deserialize, Serialize, JsonSchema)]
        struct Outer {
            inner: Inner,
            maybe: Option<Inner>,
        }
        let s = schema_for::<Outer>(true);
        let text = s.to_string();
        assert!(!text.contains("$ref"), "{text}");
        assert_eq!(s["type"], "object");
    }
}
