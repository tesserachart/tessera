use std::sync::Arc;

use async_trait::async_trait;
use tessera_host::{Cards, ModuleHost, RuntimeModule, TopicHandler, TsExports};
use tessera_protocol::cards::{Card, CardParams, GetCardInput};
use tessera_protocol::tools::RiskTier;
use tessera_protocol::topics::names;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

pub struct CardsModule(pub Arc<Cards>);

impl std::fmt::Debug for CardsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CardsModule").finish_non_exhaustive()
    }
}

impl RuntimeModule for CardsModule {
    fn name(&self) -> &'static str {
        "cards"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(GetCard(Arc::clone(&self.0)))
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![self.0.topic()]
    }
}

struct GetCard(Arc<Cards>);

#[async_trait]
impl Tool for GetCard {
    type Input = GetCardInput;
    type Output = Card;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("cards.get", "Get a card", RiskTier::Read)
            .description("A card as it stands now: one a tool showed in the chat (data coverage and its downloads), with what it holds and the actions it offers, each a tool call. Cards are kept while Tessera runs, the newest 200.")
            .activity("Reading a card")
    }

    async fn call(&self, _ctx: &ToolCtx, input: GetCardInput) -> Result<Card, ToolError> {
        self.0
            .get(&input.card_id)
            .ok_or_else(|| ToolError::not_found(format!("no card {}", input.card_id)))
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (cards)")
        .tool::<GetCardInput, Card>("cards.get")
        .topic::<CardParams, Card>(names::CARDS)
}
