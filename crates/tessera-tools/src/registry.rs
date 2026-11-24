use std::collections::BTreeMap;
use std::sync::Arc;

use tessera_protocol::tools::ToolDescriptor;

use crate::meta::{is_valid_tool_name, mcp_name};
use crate::tool::{DynTool, Tool, ToolBox};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    #[error("invalid tool name {0:?}: expected lower-case dotted segments like market.get_candles")]
    InvalidName(String),
    #[error("tool {0:?} is already registered")]
    Duplicate(String),
    #[error("tool {0:?} collides with {1:?} after MCP name mapping")]
    McpCollision(String, String),
    #[error("tool {0:?} is in the approvals namespace but not user-only")]
    ApprovalNotUserOnly(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    User,
    Agent,
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn DynTool>>,
    by_mcp: BTreeMap<String, String>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<T: Tool>(&mut self, tool: T) -> Result<(), RegistryError> {
        self.register_dyn(Arc::new(ToolBox::new(tool)))
    }

    pub fn register_dyn(&mut self, tool: Arc<dyn DynTool>) -> Result<(), RegistryError> {
        let meta = tool.meta();
        let name = meta.name.clone();
        if !is_valid_tool_name(&name) {
            return Err(RegistryError::InvalidName(name));
        }
        if name.starts_with("approvals.") && !meta.user_only {
            return Err(RegistryError::ApprovalNotUserOnly(name));
        }
        if self.tools.contains_key(&name) {
            return Err(RegistryError::Duplicate(name));
        }
        let mcp = mcp_name(&name);
        if let Some(other) = self.by_mcp.get(&mcp) {
            return Err(RegistryError::McpCollision(name, other.clone()));
        }
        self.by_mcp.insert(mcp, name.clone());
        self.tools.insert(name, tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn DynTool>> {
        self.tools.get(name).cloned()
    }

    pub fn resolve_mcp_name(&self, mcp: &str) -> Option<&str> {
        self.by_mcp.get(mcp).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.tools.keys().map(String::as_str)
    }

    pub fn descriptors(
        &self,
        audience: Audience,
        category: Option<&str>,
        include_hidden: bool,
    ) -> Vec<ToolDescriptor> {
        self.tools
            .values()
            .map(|t| t.descriptor())
            .filter(|d| audience == Audience::User || !d.user_only)
            .filter(|d| include_hidden || !d.ui_hints.hidden)
            .filter(|d| category.is_none_or(|c| d.category == c))
            .cloned()
            .collect()
    }
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("tools", &self.tools.keys().collect::<Vec<_>>())
            .finish()
    }
}
