use tessera_core::accounts::{
    AccountGroup, AccountSummary, Broker, ConnectionProvider, Environment, FundingProvider,
    PayoutPolicy, Program, RuleSet, TradingAccount,
};
use tessera_core::capabilities::{
    AgentCapabilities, BrokerCapabilities, IntelCapabilities, MarketCapabilities,
};
use tessera_core::conversion::ConversionRecord;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::levels::Level;
use tessera_core::market::{Bar, BookSnapshot, DataSource, FootprintBar, Quote, Trade};
use tessera_core::money::{Money, Rounding};
use tessera_core::orders::{Draft, Fill, Order, OrderPreview, OrderRequest, Position};
use tessera_core::session::TradingSession;
use tessera_protocol::agent::{
    AgentEvent, AgentEventEnvelope, AgentSessionSummary, AgentSessionsEvent,
};
use tessera_protocol::compact::{CompactBar, CompactLevel};
use tessera_protocol::layout::{ChartState, Layout, LayoutEvent};
use tessera_protocol::methods::{
    ApprovalsResolveParams, ApprovalsResolveResult, HelloParams, HelloResult, IntelProviderInfo,
    PulseParams, ServerCapabilities, SubscribeParams, SubscribeResult, ToolsInvokeParams,
    ToolsListParams, UnsubscribeParams, UnsubscribeResult,
};
use tessera_protocol::rpc::{
    EventEnvelope, EventNotification, RequestId, RpcError, RpcRequest, RpcResponse,
};
use tessera_protocol::tools::{
    Approval, ApprovalEvent, DraftInfo, RiskTier, SessionMode, ToolCallEvent, ToolCallRecord,
    ToolDescriptor, ToolResult,
};
use tessera_protocol::topics::{
    AccountParams, AccountUpdate, AgentSessionParams, BarsParams, HealthUpdate, InstrumentParams,
    InstrumentsParams, LayoutParams, LevelsUpdate, NoParams, Notification, OrderUpdate,
    PositionUpdate, ResearchRunParams, ToolCallsParams,
};

use crate::ts::TsExports;

pub fn protocol_exports() -> TsExports {
    TsExports::new("tessera-protocol")
        .ty::<RpcRequest>()
        .ty::<RpcResponse>()
        .ty::<RpcError>()
        .ty::<EventEnvelope>()
        .ty::<EventNotification>()
        .ty::<RequestId>()
        .ty::<HelloParams>()
        .ty::<HelloResult>()
        .ty::<PulseParams>()
        .ty::<ServerCapabilities>()
        .ty::<IntelProviderInfo>()
        .ty::<ToolsListParams>()
        .ty::<ToolsInvokeParams>()
        .ty::<SubscribeParams>()
        .ty::<SubscribeResult>()
        .ty::<UnsubscribeParams>()
        .ty::<UnsubscribeResult>()
        .ty::<ApprovalsResolveParams>()
        .ty::<ApprovalsResolveResult>()
        .ty::<ToolDescriptor>()
        .ty::<ToolResult>()
        .ty::<ToolCallRecord>()
        .ty::<ToolCallEvent>()
        .ty::<Approval>()
        .ty::<ApprovalEvent>()
        .ty::<DraftInfo>()
        .ty::<SessionMode>()
        .ty::<RiskTier>()
        .ty::<NoParams>()
        .ty::<InstrumentsParams>()
        .ty::<InstrumentParams>()
        .ty::<BarsParams>()
        .ty::<AccountParams>()
        .ty::<AgentSessionParams>()
        .ty::<ToolCallsParams>()
        .ty::<ResearchRunParams>()
        .ty::<LayoutParams>()
        .ty::<LevelsUpdate>()
        .ty::<OrderUpdate>()
        .ty::<PositionUpdate>()
        .ty::<AccountUpdate>()
        .ty::<HealthUpdate>()
        .ty::<Notification>()
        .ty::<AgentEvent>()
        .ty::<AgentEventEnvelope>()
        .ty::<AgentSessionSummary>()
        .ty::<AgentSessionsEvent>()
        .ty::<Layout>()
        .ty::<LayoutEvent>()
        .ty::<ChartState>()
        .ty::<CompactBar>()
        .ty::<CompactLevel>()
        .ty::<Instrument>()
        .ty::<ContractSpec>()
        .ty::<AssetClass>()
        .ty::<Quote>()
        .ty::<Trade>()
        .ty::<DataSource>()
        .ty::<Bar>()
        .ty::<BookSnapshot>()
        .ty::<FootprintBar>()
        .ty::<Level>()
        .ty::<ConversionRecord>()
        .ty::<Money>()
        .ty::<Rounding>()
        .ty::<OrderRequest>()
        .ty::<OrderPreview>()
        .ty::<Draft>()
        .ty::<Order>()
        .ty::<Fill>()
        .ty::<Position>()
        .ty::<TradingAccount>()
        .ty::<AccountSummary>()
        .ty::<AccountGroup>()
        .ty::<ConnectionProvider>()
        .ty::<Broker>()
        .ty::<FundingProvider>()
        .ty::<Program>()
        .ty::<RuleSet>()
        .ty::<PayoutPolicy>()
        .ty::<Environment>()
        .ty::<ProviderHealth>()
        .ty::<TradingSession>()
        .ty::<MarketCapabilities>()
        .ty::<IntelCapabilities>()
        .ty::<BrokerCapabilities>()
        .ty::<AgentCapabilities>()
}
