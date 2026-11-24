use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_cloud::{CloudError, NewShare, ShareImage, SharedLink};
use tessera_host::{RuntimeModule, TsExports};
use tessera_protocol::tools::RiskTier;
use tessera_tools::{RateLimit, RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use ts_rs::TS;

use crate::modules::account::AccountService;
use crate::modules::feedback::Scrubber;

const SHARE_ENTITLEMENT: &str = "share";

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

const MAX_TITLE: usize = 120;

const MAX_SIDE: u32 = 16_384;

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

const JPEG_SIGNATURE: &[u8] = &[0xff, 0xd8, 0xff];

const CREATE_RATE: RateLimit = RateLimit::new(0.2, 5);

/// A picture of a chart, already redacted by the window that took it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareImageInput {
    /// `image/png` or `image/jpeg`.
    #[serde(rename = "type")]
    pub mime_type: String,
    /// The image, base64.
    pub data: String,
    /// Its width in pixels.
    pub width: u32,
    /// Its height in pixels.
    pub height: u32,
}

/// `share.chart` input: the chart's picture and what it shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareChartInput {
    /// The chart's picture.
    pub image: ShareImageInput,
    /// The chart's instrument (`NQZ6.CME`), or null.
    #[serde(default)]
    pub instrument: Option<String>,
    /// The chart's timeframe (`5m`), or null.
    #[serde(default)]
    pub timeframe: Option<String>,
}

/// A link the user shared.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    /// Its id, the last part of the link.
    pub id: String,
    /// The unlisted link anyone holding it can open, signed out.
    pub url: String,
    /// What was shared (`chart`).
    pub kind: String,
    /// What the page calls it (`NQZ6 · 5m`).
    pub title: String,
    /// When it was shared (RFC 3339).
    pub created_at: String,
}

impl From<SharedLink> for ShareLink {
    fn from(l: SharedLink) -> Self {
        Self {
            id: l.id,
            url: l.url,
            kind: l.kind,
            title: l.title,
            created_at: l.created_at,
        }
    }
}

/// `share.list` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareListInput {}

/// `share.list` output: the user's own links.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareListOutput {
    /// Whether this account can share now: signed in to Tessera with sharing on.
    pub available: bool,
    /// The links, newest first; empty when sharing is not available.
    pub shares: Vec<ShareLink>,
}

/// `share.delete` input: the link to take down.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareDeleteInput {
    /// The link's id (from share.list).
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareDeleteOutput {
    /// The id taken down; its link no longer opens.
    pub id: String,
}

#[async_trait]
pub trait ShareCloud: Send + Sync + 'static {
    fn available(&self) -> bool;

    async fn create(&self, share: &NewShare) -> Result<SharedLink, CloudError>;

    async fn list(&self) -> Result<Vec<SharedLink>, CloudError>;

    async fn delete(&self, id: &str) -> Result<(), CloudError>;
}

pub struct CloudShares(pub Arc<AccountService>);

#[async_trait]
impl ShareCloud for CloudShares {
    fn available(&self) -> bool {
        self.0.signed_in()
            && self
                .0
                .state()
                .entitlements
                .iter()
                .any(|e| e == SHARE_ENTITLEMENT)
    }

    async fn create(&self, share: &NewShare) -> Result<SharedLink, CloudError> {
        self.0.cloud()?.create_share(share).await
    }

    async fn list(&self) -> Result<Vec<SharedLink>, CloudError> {
        self.0.cloud()?.shares().await
    }

    async fn delete(&self, id: &str) -> Result<(), CloudError> {
        self.0.cloud()?.delete_share(id).await
    }
}

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub fn chart_title(instrument: Option<&str>, timeframe: Option<&str>) -> String {
    let scrubber = Scrubber::default();
    let parts: Vec<String> = [instrument, timeframe]
        .into_iter()
        .flatten()
        .map(|p| scrubber.scrub(p.trim()))
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        "Chart".to_owned()
    } else {
        clip(&parts.join(" · "), MAX_TITLE)
    }
}

pub fn checked_image(image: &ShareImageInput) -> Result<ShareImage, ToolError> {
    let signature = match image.mime_type.as_str() {
        "image/png" => PNG_SIGNATURE,
        "image/jpeg" => JPEG_SIGNATURE,
        _ => return Err(ToolError::invalid_input("the picture is not a PNG or JPEG")),
    };
    if !(1..=MAX_SIDE).contains(&image.width) || !(1..=MAX_SIDE).contains(&image.height) {
        return Err(ToolError::invalid_input(
            "the picture's size is out of range",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image.data.as_bytes())
        .map_err(|_| ToolError::invalid_input("the picture is not base64"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ToolError::invalid_input("the picture is larger than 8 MB"));
    }
    if !bytes.starts_with(signature) {
        return Err(ToolError::invalid_input(
            "the picture is not the type it says",
        ));
    }
    Ok(ShareImage {
        mime_type: image.mime_type.clone(),
        data: image.data.clone(),
    })
}

fn cloud_error(e: CloudError) -> ToolError {
    if e.needs_sign_in() {
        ToolError::permission_denied("Sign in to Tessera to share.")
    } else if e.is_unreachable() {
        ToolError::unavailable("Tessera Cloud can’t be reached. Try again in a moment.")
    } else if let CloudError::Server { status: 404, .. } = e {
        ToolError::not_found("That link is already gone.")
    } else if let CloudError::Server {
        status: 503 | 403, ..
    } = e
    {
        ToolError::unavailable("Sharing isn’t on for this account.")
    } else {
        tracing::warn!(error = %e, "Tessera Cloud refused a share");
        ToolError::unavailable("Tessera Cloud couldn’t take the share. Try again in a moment.")
    }
}

pub struct ShareService {
    cloud: Arc<dyn ShareCloud>,
}

impl std::fmt::Debug for ShareService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareService").finish_non_exhaustive()
    }
}

impl ShareService {
    pub fn new(cloud: Arc<dyn ShareCloud>) -> Arc<Self> {
        Arc::new(Self { cloud })
    }

    fn ready(&self) -> Result<(), ToolError> {
        if self.cloud.available() {
            Ok(())
        } else {
            Err(ToolError::unavailable("Sign in to Tessera to share."))
        }
    }

    pub async fn chart(&self, input: &ShareChartInput) -> Result<ShareLink, ToolError> {
        self.ready()?;
        let image = checked_image(&input.image)?;
        let share = NewShare {
            kind: "chart".to_owned(),
            title: chart_title(input.instrument.as_deref(), input.timeframe.as_deref()),
            image,
            width: input.image.width,
            height: input.image.height,
        };
        let link = self.cloud.create(&share).await.map_err(cloud_error)?;
        tracing::info!(share = %link.id, "chart shared");
        Ok(link.into())
    }

    pub async fn list(&self) -> Result<ShareListOutput, ToolError> {
        if !self.cloud.available() {
            return Ok(ShareListOutput {
                available: false,
                shares: Vec::new(),
            });
        }
        let shares = self.cloud.list().await.map_err(cloud_error)?;
        Ok(ShareListOutput {
            available: true,
            shares: shares.into_iter().map(ShareLink::from).collect(),
        })
    }

    pub async fn delete(&self, input: &ShareDeleteInput) -> Result<ShareDeleteOutput, ToolError> {
        self.ready()?;
        let id = input.id.trim();
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(ToolError::invalid_input("that is not a share id"));
        }
        self.cloud.delete(id).await.map_err(cloud_error)?;
        tracing::info!(share = %id, "share deleted");
        Ok(ShareDeleteOutput { id: id.to_owned() })
    }
}

pub struct ShareModule(pub Arc<ShareService>);

impl std::fmt::Debug for ShareModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareModule").finish_non_exhaustive()
    }
}

impl RuntimeModule for ShareModule {
    fn name(&self) -> &'static str {
        "share"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(ChartTool(Arc::clone(&self.0)))?;
        r.register(ListTool(Arc::clone(&self.0)))?;
        r.register(DeleteTool(Arc::clone(&self.0)))?;
        Ok(())
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (share)")
        .tool::<ShareChartInput, ShareLink>("share.chart")
        .tool::<ShareListInput, ShareListOutput>("share.list")
        .tool::<ShareDeleteInput, ShareDeleteOutput>("share.delete")
}

struct ChartTool(Arc<ShareService>);

#[async_trait]
impl Tool for ChartTool {
    type Input = ShareChartInput;
    type Output = ShareLink;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("share.chart", "Share a chart", RiskTier::Modify)
            .description("Uploads the user's redacted picture of a chart to Tessera Cloud and answers an unlisted link that opens signed out: the picture, its instrument and timeframe, and the Tessera mark, never the account. Only the signed-in owner can list or delete it (share.list, share.delete).")
            .user_only()
            .rate_limit(CREATE_RATE)
            .redact(&["image"])
            .timeout_ms(100_000)
    }

    async fn call(&self, _ctx: &ToolCtx, input: ShareChartInput) -> Result<ShareLink, ToolError> {
        self.0.chart(&input).await
    }
}

struct ListTool(Arc<ShareService>);

#[async_trait]
impl Tool for ListTool {
    type Input = ShareListInput;
    type Output = ShareListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("share.list", "Read your shared links", RiskTier::Read)
            .description("The links the signed-in user shared, newest first, and whether sharing is available to them now.")
            .user_only()
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: ShareListInput,
    ) -> Result<ShareListOutput, ToolError> {
        self.0.list().await
    }
}

struct DeleteTool(Arc<ShareService>);

#[async_trait]
impl Tool for DeleteTool {
    type Input = ShareDeleteInput;
    type Output = ShareDeleteOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("share.delete", "Delete a shared link", RiskTier::Modify)
            .description("Takes down one of the user's shared links: its page and picture stop opening for anyone.")
            .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: ShareDeleteInput,
    ) -> Result<ShareDeleteOutput, ToolError> {
        self.0.delete(&input).await
    }
}

#[cfg(test)]
mod tests;
