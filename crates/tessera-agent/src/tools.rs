use std::sync::Arc;

use async_trait::async_trait;
use tessera_core::ids::SessionId;
use tessera_protocol::agent::{
    AgentAttachmentData, AgentAttachmentIdInput, AgentDeleteSessionInput, AgentDeleteSessionOutput,
    AgentDiscardAttachmentOutput, AgentEditQueuedInput, AgentEvent, AgentEventEnvelope,
    AgentGetTranscriptInput, AgentInstallInput, AgentInstallOutput, AgentInterruptInput,
    AgentInterruptOutput, AgentListProvidersInput, AgentListSessionsInput, AgentProvidersOutput,
    AgentRemoveQueuedInput, AgentRenameSessionInput, AgentResumeQueueInput, AgentSearchHit,
    AgentSearchOutput, AgentSearchSessionsInput, AgentSendInput, AgentSendOutput,
    AgentSessionOutput, AgentSessionsOutput, AgentSetModeInput, AgentSetModelInput,
    AgentSignInInput, AgentSignInOutput, AgentStartSessionInput, AgentTranscriptEntry,
    AgentTranscriptOutput, AgentUploadAttachmentInput, AgentUploadAttachmentOutput, TranscriptRole,
};
use tessera_protocol::tools::RiskTier;
use tessera_store::Store;
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::service::AgentService;

fn listed(mut meta: ToolMeta) -> ToolMeta {
    meta = meta.user_only();
    meta.ui.hidden = false;
    meta
}

fn service<'a>(
    ctx: &ToolCtx,
    s: &'a Option<Arc<AgentService>>,
) -> Result<&'a Arc<AgentService>, ToolError> {
    if !ctx.origin.is_user() {
        return Err(ToolError::permission_denied(
            "only the user controls analyst sessions",
        ));
    }
    running(s)
}

fn running(s: &Option<Arc<AgentService>>) -> Result<&Arc<AgentService>, ToolError> {
    s.as_ref()
        .ok_or_else(|| ToolError::unavailable("no analyst provider runs in this runtime"))
}

fn store_error(e: impl std::fmt::Display) -> ToolError {
    ToolError::internal(e.to_string())
}

async fn blocking<T: std::marker::Send + 'static>(
    f: impl FnOnce() -> Result<T, ToolError> + std::marker::Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(f).await.map_err(store_error)?
}

struct StartSession(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for StartSession {
    type Input = AgentStartSessionInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new(
                "agent.start_session",
                "Start an analyst session",
                RiskTier::Modify,
            )
            .description(
                "Opens an analyst session on a connected provider (Codex, Claude Code) with a model \
                 and effort, and a preset's tools.",
            )
            .activity("Started an analyst session"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentStartSessionInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: service(ctx, &self.0)?.start_session(input).await?,
        })
    }
}

struct Send(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for Send {
    type Input = AgentSendInput;
    type Output = AgentSendOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.send", "Ask the analyst", RiskTier::Modify)
                .description("Sends the user's message to an analyst session, with its attachments (images and files \
                    uploaded with agent.upload_attachment) and the model and effort to answer with from now on; the \
                    answer streams on agent.session. An idle session starts a turn with it. While a turn runs, \
                    delivery steer puts it into that turn, which reads it at its next step (a provider that can't \
                    take a message mid-run queues it instead and notice says so); queue, the default, adds it to the \
                    session's queue, sent as its own turn once the running turn and the messages before it are done. \
                    delivered says which happened.")
                .activity("Asked the analyst"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentSendInput,
    ) -> Result<AgentSendOutput, ToolError> {
        service(ctx, &self.0)?
            .send_with(
                &input.session_id,
                &input.text,
                &input.attachments,
                input.model,
                input.effort,
                input.delivery,
            )
            .await
    }
}

struct UploadAttachment(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for UploadAttachment {
    type Input = AgentUploadAttachmentInput;
    type Output = AgentUploadAttachmentOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.upload_attachment", "Attach a file", RiskTier::Modify)
                .description(
                    "Uploads an image (PNG, JPEG, GIF or WebP, 10 MiB at most) or a file (a PDF or text, 50 MiB at \
                     most) for the user's next message, base64, a piece of 4 MiB at most at a time. An upload no \
                     message carries is removed after a day.",
                )
                .activity("Attached a file")
                .redact(&["dataBase64"])
                .quiet(),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentUploadAttachmentInput,
    ) -> Result<AgentUploadAttachmentOutput, ToolError> {
        let store = service(ctx, &self.0)?.attachments()?.clone();
        let now = tessera_core::Timestamp::now();
        blocking(move || store.upload(&input, now)).await
    }
}

struct GetAttachment(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for GetAttachment {
    type Input = AgentAttachmentIdInput;
    type Output = AgentAttachmentData;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.get_attachment", "Open an attachment", RiskTier::Read)
                .description("An image or file attached to a message, base64.")
                .activity("Opened an attachment")
                .quiet(),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentAttachmentIdInput,
    ) -> Result<AgentAttachmentData, ToolError> {
        let store = service(ctx, &self.0)?.attachments()?.clone();
        blocking(move || {
            let (attachment, bytes) = store.get(&input.id)?;
            Ok(AgentAttachmentData {
                attachment,
                data_base64: tessera_core::b64::encode(&bytes),
            })
        })
        .await
    }
}

struct DiscardAttachment(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for DiscardAttachment {
    type Input = AgentAttachmentIdInput;
    type Output = AgentDiscardAttachmentOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new(
                "agent.discard_attachment",
                "Remove an attachment",
                RiskTier::Modify,
            )
            .description("Removes an upload the user took off their message before sending it.")
            .activity("Removed an attachment")
            .quiet(),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentAttachmentIdInput,
    ) -> Result<AgentDiscardAttachmentOutput, ToolError> {
        let store = service(ctx, &self.0)?.attachments()?.clone();
        let discarded = blocking(move || store.discard(&input.id)).await?;
        Ok(AgentDiscardAttachmentOutput { discarded })
    }
}

struct Interrupt(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for Interrupt {
    type Input = AgentInterruptInput;
    type Output = AgentInterruptOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.interrupt", "Stop the analyst", RiskTier::Modify)
                .description("Stops the analyst's current turn.")
                .activity("Stopped the analyst"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentInterruptInput,
    ) -> Result<AgentInterruptOutput, ToolError> {
        let interrupted = service(ctx, &self.0)?.interrupt(&input.session_id).await?;
        Ok(AgentInterruptOutput {
            session_id: input.session_id,
            interrupted,
        })
    }
}

struct EditQueued(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for EditQueued {
    type Input = AgentEditQueuedInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.edit_queued", "Edit a queued message", RiskTier::Modify)
                .description(
                    "Gives a message waiting in a session's queue new words; its attachments stay. One with no \
                     attachments needs words.",
                )
                .activity("Edited a queued message"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentEditQueuedInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: service(ctx, &self.0)?.edit_queued(
                &input.session_id,
                &input.queued_id,
                &input.text,
            )?,
        })
    }
}

struct RemoveQueued(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for RemoveQueued {
    type Input = AgentRemoveQueuedInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.remove_queued", "Remove a queued message", RiskTier::Modify)
                .description(
                    "Takes a message out of a session's queue unsent, with its attachments. A held queue left \
                     empty is no longer held.",
                )
                .activity("Removed a queued message"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentRemoveQueuedInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: service(ctx, &self.0)?.remove_queued(&input.session_id, &input.queued_id)?,
        })
    }
}

struct ResumeQueue(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for ResumeQueue {
    type Input = AgentResumeQueueInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new(
                "agent.resume_queue",
                "Resume the analyst's queue",
                RiskTier::Modify,
            )
            .description(
                "Sends a session's held queue on (Stop, a turn that failed or a restart holds it): its first \
                 message starts a turn now when none runs, and the rest follow in order.",
            )
            .activity("Resumed the analyst's queue"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentResumeQueueInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: service(ctx, &self.0)?
                .resume_queue(&input.session_id)
                .await?,
        })
    }
}

struct SetModel(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for SetModel {
    type Input = AgentSetModelInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "agent.set_model",
            "Change the analyst's model",
            RiskTier::Modify,
        )
            .description("Sets the model and reasoning effort a session's next turns use (the composer's model pick): a model id of the session's own provider and one of that model's efforts, as agent.list_providers lists them; a new model without an effort takes the model's default. The turn running now finishes on the model it started with. A new conversation's model is the agent.defaultModel setting.")
            .activity("Changed the analyst's model")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AgentSetModelInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: running(&self.0)?
                .set_model(&input.session_id, input.model, input.effort)
                .await?,
        })
    }
}

struct SetMode(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for SetMode {
    type Input = AgentSetModeInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new(
                "agent.set_mode",
                "Change the analyst's mode",
                RiskTier::Modify,
            )
            .description(
                "Sets a session's mode, the user's alone: supervised, auto_modify, read_only \
                     or full_access (the analyst's orders run without asking, under the trader's \
                     limits). It applies from the session's next tool call.",
            )
            .activity("Changed the analyst's mode"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentSetModeInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: service(ctx, &self.0)?.set_mode(&input.session_id, input.mode)?,
        })
    }
}

struct Rename(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for Rename {
    type Input = AgentRenameSessionInput;
    type Output = AgentSessionOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("agent.rename_session", "Rename a session", RiskTier::Modify)
            .description(
                "Renames an analyst session (its title in the session list; at most 120 characters).",
            )
            .activity("Renamed a session")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AgentRenameSessionInput,
    ) -> Result<AgentSessionOutput, ToolError> {
        Ok(AgentSessionOutput {
            session: running(&self.0)?.rename(&input.session_id, &input.title)?,
        })
    }
}

struct Delete(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for Delete {
    type Input = AgentDeleteSessionInput;
    type Output = AgentDeleteSessionOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.delete_session", "Delete a session", RiskTier::Modify)
                .description(
                    "Deletes an analyst session and its transcript, stopping it first if it runs.",
                )
                .activity("Deleted a session"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentDeleteSessionInput,
    ) -> Result<AgentDeleteSessionOutput, ToolError> {
        let deleted = service(ctx, &self.0)?.delete(&input.session_id).await?;
        Ok(AgentDeleteSessionOutput {
            session_id: input.session_id,
            deleted,
        })
    }
}

struct ListProviders(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for ListProviders {
    type Input = AgentListProvidersInput;
    type Output = AgentProvidersOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "agent.list_providers",
            "List the analyst's models",
            RiskTier::Read,
        )
        .description(
            "The agent providers (Codex, Claude Code): whether the user turned each on (the agent.providers \
             setting, the user's alone; one that is off is `disabled` and Tessera never runs or checks it), \
             whether one that is on is installed and signed in and when it was last checked, and its models \
             with their reasoning efforts, the default first. Their ids are what agent.set_model and the \
             agent.defaultModel setting take. recheck: true checks every provider that is on again first \
             (Settings › Analyst's Check again).",
        )
        .activity("Listed the analyst's models")
        .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AgentListProvidersInput,
    ) -> Result<AgentProvidersOutput, ToolError> {
        Ok(running(&self.0)?
            .providers_info(input.recheck.unwrap_or(false))
            .await)
    }
}

struct Install(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for Install {
    type Input = AgentInstallInput;
    type Output = AgentInstallOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new("agent.install", "Install a provider", RiskTier::Modify)
                .description(
                    "Installs a provider that is on but not installed (Claude Code) with its vendor's own \
                     installer, run on the user's computer, then checks it again. Codex has no installer here: \
                     the user gets it from its download page.",
                )
                .activity("Installed a provider"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentInstallInput,
    ) -> Result<AgentInstallOutput, ToolError> {
        service(ctx, &self.0)?.install(&input.provider).await
    }
}

struct SignIn(Option<Arc<AgentService>>);

#[async_trait]
impl Tool for SignIn {
    type Input = AgentSignInInput;
    type Output = AgentSignInOutput;

    fn meta(&self) -> ToolMeta {
        listed(
            ToolMeta::new(
                "agent.sign_in",
                "Sign a provider in",
                RiskTier::Modify,
            )
            .description(
                "Starts signing a provider that is on (Codex, Claude Code) in to the user's own account: the page \
                 they finish it on in their browser, which the CLI may have opened itself. A sign-in already running \
                 is replaced. With code, hands the running sign-in the code its page showed instead. The provider \
                 reads as signed in by itself once they finished.",
            )
            .activity("Signed a provider in"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: AgentSignInInput,
    ) -> Result<AgentSignInOutput, ToolError> {
        service(ctx, &self.0)?
            .sign_in(&input.provider, input.code.as_deref())
            .await
    }
}

const TRANSCRIPT_PAGE: u32 = 50;
const TRANSCRIPT_MAX: u32 = 200;
const ENTRY_TEXT_MAX: usize = 2_000;
const SCAN_BATCH: u32 = 500;

fn cut(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= ENTRY_TEXT_MAX {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(ENTRY_TEXT_MAX).collect();
    out.push('…');
    out
}

fn entry(env: &AgentEventEnvelope) -> Option<AgentTranscriptEntry> {
    let (role, text, tool, outcome) = match &env.event {
        AgentEvent::UserMessage { text, attachments } => {
            let mut text = cut(text);
            if !attachments.is_empty() {
                let names: Vec<&str> = attachments.iter().map(|a| a.label.as_str()).collect();
                text = format!("{text} [attached: {}]", names.join(", "))
                    .trim_start()
                    .to_owned();
            }
            (TranscriptRole::User, text, None, None)
        }
        AgentEvent::AssistantMessage { text, .. } => {
            (TranscriptRole::Assistant, cut(text), None, None)
        }
        AgentEvent::ToolCallFinished {
            tool,
            outcome,
            result_summary,
            error,
            ..
        } => (
            TranscriptRole::Tool,
            cut(result_summary
                .as_deref()
                .or(error.as_ref().map(|e| e.message.as_str()))
                .unwrap_or_default()),
            Some(tool.clone()),
            Some(*outcome),
        ),
        AgentEvent::ApprovalRequested { tool, kind, .. } => (
            TranscriptRole::Approval,
            format!(
                "asked the user to approve ({})",
                serde_json::to_value(kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default()
            ),
            Some(tool.clone()),
            None,
        ),
        AgentEvent::ApprovalResolved { status, .. } => (
            TranscriptRole::Approval,
            format!(
                "the approval ended {}",
                serde_json::to_value(status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default()
            ),
            None,
            None,
        ),
        AgentEvent::Error { message, .. } => (TranscriptRole::Error, cut(message), None, None),
        _ => return None,
    };
    Some(AgentTranscriptEntry {
        seq: env.seq,
        ts: env.ts,
        role,
        text,
        tool,
        outcome,
    })
}

fn transcript_page(
    store: &Store,
    sid: &SessionId,
    after: u64,
    limit: usize,
) -> Result<(Vec<AgentTranscriptEntry>, u64, bool), ToolError> {
    let mut entries = Vec::new();
    let mut last = after;
    loop {
        let batch = store
            .agent_events()
            .list(sid.as_str(), last, SCAN_BATCH)
            .map_err(store_error)?;
        let read = batch.len();
        for env in &batch {
            if let Some(e) = entry(env) {
                if entries.len() == limit {
                    return Ok((entries, last, true));
                }
                entries.push(e);
            }
            last = env.seq;
        }
        if read < SCAN_BATCH as usize {
            return Ok((entries, last, false));
        }
    }
}

struct ListSessions(Store);

#[async_trait]
impl Tool for ListSessions {
    type Input = AgentListSessionsInput;
    type Output = AgentSessionsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("agent.list_sessions", "List analyst sessions", RiskTier::Read)
            .description("Every analyst session, the most recently active first: its id, title, provider, model and effort, mode (supervised, auto_modify, read_only, full_access), status and when it started and was last active. Read one with agent.get_transcript; search them all with agent.search_sessions; show one in the Agents area with ui.show_area {area: agents, item: <session id>}.")
            .activity("Listed analyst sessions")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: AgentListSessionsInput,
    ) -> Result<AgentSessionsOutput, ToolError> {
        let store = self.0.clone();
        let sessions = blocking(move || store.sessions().list().map_err(store_error)).await?;
        Ok(AgentSessionsOutput { sessions })
    }

    fn summarize(&self, o: &AgentSessionsOutput) -> Option<String> {
        Some(format!("{} sessions", o.sessions.len()))
    }
}

struct GetTranscript(Store);

#[async_trait]
impl Tool for GetTranscript {
    type Input = AgentGetTranscriptInput;
    type Output = AgentTranscriptOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("agent.get_transcript", "Read a session", RiskTier::Read)
            .description("An analyst session's conversation, oldest first, a page at a time (default 50 entries, at most 200; pass the page's lastSeq as afterSeq for the next): the user's messages and the analyst's answers (each cut at 2,000 characters), every tool call by name with its outcome and one-line summary (never its raw answer), approvals asked and how they ended, and errors. Streaming, reasoning and status lines are left out. Use it to pick up earlier work.")
            .activity("Read a session")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AgentGetTranscriptInput,
    ) -> Result<AgentTranscriptOutput, ToolError> {
        let store = self.0.clone();
        let limit = input
            .limit
            .unwrap_or(TRANSCRIPT_PAGE)
            .clamp(1, TRANSCRIPT_MAX) as usize;
        let after = input.after_seq.unwrap_or(0);
        blocking(move || {
            let sid = input.session_id;
            let session = store
                .sessions()
                .get(sid.as_str())
                .map_err(store_error)?
                .ok_or_else(|| {
                    ToolError::not_found(format!(
                        "no session {sid} (agent.list_sessions lists them)"
                    ))
                })?;
            let (entries, last_seq, more) = transcript_page(&store, &sid, after, limit)?;
            Ok(AgentTranscriptOutput {
                session,
                entries,
                last_seq,
                more,
            })
        })
        .await
    }

    fn summarize(&self, o: &AgentTranscriptOutput) -> Option<String> {
        Some(format!(
            "{} · {} entries{}",
            o.session.title,
            o.entries.len(),
            if o.more { ", more" } else { "" }
        ))
    }
}

struct SearchSessions(Store);

const SEARCH_DEFAULT: u32 = 20;
const SEARCH_MAX: u32 = 100;

#[async_trait]
impl Tool for SearchSessions {
    type Input = AgentSearchSessionsInput;
    type Output = AgentSearchOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("agent.search_sessions", "Search analyst sessions", RiskTier::Read)
            .description("Searches every analyst session's messages (the user's and the analyst's) for plain words, all of which a message must hold (word stems match: `reverting` finds `reversion`). Each hit names its session and the message's position (read around it with agent.get_transcript afterSeq = seq − 1) with the matching words in [ ]; the best matches first (default 20, at most 100).")
            .activity("Searched analyst sessions")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AgentSearchSessionsInput,
    ) -> Result<AgentSearchOutput, ToolError> {
        if input.query.trim().is_empty() {
            return Err(ToolError::invalid_input("give words to search for"));
        }
        let store = self.0.clone();
        let limit = input.limit.unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX);
        blocking(move || {
            let found = store
                .search()
                .search(&input.query, Some("agent_event"), limit)
                .map_err(store_error)?;
            let mut titles = std::collections::HashMap::<String, String>::new();
            let mut hits = Vec::with_capacity(found.len());
            for h in found {
                let Some((sid, seq)) = h.ref_id.rsplit_once(':') else {
                    continue;
                };
                let Ok(seq) = seq.parse::<u64>() else {
                    continue;
                };
                let title = match titles.get(sid) {
                    Some(t) => t.clone(),
                    None => {
                        let t = store
                            .sessions()
                            .get(sid)
                            .map_err(store_error)?
                            .map(|s| s.title)
                            .unwrap_or_default();
                        titles.insert(sid.to_owned(), t.clone());
                        t
                    }
                };
                hits.push(AgentSearchHit {
                    session_id: SessionId::new(sid),
                    title,
                    seq,
                    snippet: h.snippet,
                });
            }
            Ok(AgentSearchOutput { hits })
        })
        .await
    }

    fn summarize(&self, o: &AgentSearchOutput) -> Option<String> {
        Some(format!("{} hits", o.hits.len()))
    }
}

pub fn register(
    r: &mut ToolRegistry,
    store: &Store,
    service: Option<&Arc<AgentService>>,
) -> Result<(), RegistryError> {
    r.register(ListSessions(store.clone()))?;
    r.register(GetTranscript(store.clone()))?;
    r.register(SearchSessions(store.clone()))?;
    r.register(StartSession(service.cloned()))?;
    r.register(Send(service.cloned()))?;
    r.register(UploadAttachment(service.cloned()))?;
    r.register(GetAttachment(service.cloned()))?;
    r.register(DiscardAttachment(service.cloned()))?;
    r.register(Interrupt(service.cloned()))?;
    r.register(EditQueued(service.cloned()))?;
    r.register(RemoveQueued(service.cloned()))?;
    r.register(ResumeQueue(service.cloned()))?;
    r.register(SetModel(service.cloned()))?;
    r.register(SetMode(service.cloned()))?;
    r.register(Rename(service.cloned()))?;
    r.register(Delete(service.cloned()))?;
    r.register(ListProviders(service.cloned()))?;
    r.register(Install(service.cloned()))?;
    r.register(SignIn(service.cloned()))
}
