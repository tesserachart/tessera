use std::sync::Arc;
use std::time::Duration;

use tessera_core::ids::SessionId;
use tessera_protocol::agent::TurnEnd;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_tokens: u64,
}

impl std::ops::Add for TurnUsage {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens + other.input_tokens,
            output_tokens: self.output_tokens + other.output_tokens,
            cached_input_tokens: self.cached_input_tokens + other.cached_input_tokens,
            reasoning_tokens: self.reasoning_tokens + other.reasoning_tokens,
        }
    }
}

impl std::ops::Sub for TurnUsage {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(other.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(other.output_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(other.cached_input_tokens),
            reasoning_tokens: self.reasoning_tokens.saturating_sub(other.reasoning_tokens),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnReport {
    pub session: SessionId,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub latency: Duration,
    pub end: TurnEnd,
    pub error: Option<String>,
    pub usage: Option<TurnUsage>,
}

pub type TurnSink = Arc<dyn Fn(TurnReport) + Send + Sync>;
