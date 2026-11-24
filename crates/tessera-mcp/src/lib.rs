pub mod discovery;
pub mod exposure;
pub mod json;
pub mod principals;
pub mod server;
pub mod setup;
pub mod tokens;

pub use discovery::{DISCOVERY_FILE, Discovery};
pub use exposure::McpToolMap;
pub use principals::McpPrincipals;
pub use server::{McpHook, McpService};
pub use tokens::{ClientToken, IssuedToken, TokenBook};

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

pub const MCP_PATH: &str = "/mcp";
