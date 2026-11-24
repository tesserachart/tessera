use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::tools::RiskTier;
use tessera_protocol::watchlists::{
    Watchlist, WatchlistOutput, WatchlistsAddInput, WatchlistsCreateInput, WatchlistsDeleteInput,
    WatchlistsListInput, WatchlistsMoveInput, WatchlistsOutput, WatchlistsRemoveInput,
    WatchlistsRenameInput,
};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::watchlists::WatchlistService;

const SYMBOLS: &str = "Symbols are kept as the user writes them: NQ follows the front month, NQZ6.CME is that contract. The user's Markets area and every chart's symbol popover show the lists live.";

fn words(l: &Watchlist) -> String {
    let n = l.symbols.len();
    format!("{} · {n} symbol{}", l.name, if n == 1 { "" } else { "s" })
}

fn lists_words(o: &WatchlistsOutput) -> String {
    let n = o.lists.len();
    format!("{n} watchlist{}", if n == 1 { "" } else { "s" })
}

struct List(Arc<WatchlistService>);

#[async_trait]
impl Tool for List {
    type Input = WatchlistsListInput;
    type Output = WatchlistsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.list", "List watchlists", RiskTier::Read)
            .description(format!("The user's watchlists in their order: each one's id, name and symbols in order. {SYMBOLS} Quotes for them: market.get_quote; every instrument a connection serves: market.list_instruments."))
            .activity("Listed watchlists")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: WatchlistsListInput,
    ) -> Result<WatchlistsOutput, ToolError> {
        Ok(self.0.list())
    }

    fn summarize(&self, o: &WatchlistsOutput) -> Option<String> {
        Some(lists_words(o))
    }
}

struct Create(Arc<WatchlistService>);

#[async_trait]
impl Tool for Create {
    type Input = WatchlistsCreateInput;
    type Output = WatchlistOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.create", "Create a watchlist", RiskTier::Modify)
            .description(format!("Makes a new watchlist after the others, named `name` (1–40 characters; a name another list has, in any case, is refused), with `symbols` in order (empty and repeated ones dropped). Its id comes from the name (Futures: futures, futures-2…). At most 50 lists of 500 symbols. {SYMBOLS}"))
            .activity("Created a watchlist")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WatchlistsCreateInput,
    ) -> Result<WatchlistOutput, ToolError> {
        self.0.create(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WatchlistOutput) -> Option<String> {
        Some(words(&o.list))
    }
}

struct Rename(Arc<WatchlistService>);

#[async_trait]
impl Tool for Rename {
    type Input = WatchlistsRenameInput;
    type Output = WatchlistOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.rename", "Rename a watchlist", RiskTier::Modify)
            .description("Renames watchlist `id` (watchlists.list) to `name` (1–40 characters; a name another list has is refused). Its id stays.")
            .activity("Renamed a watchlist")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WatchlistsRenameInput,
    ) -> Result<WatchlistOutput, ToolError> {
        self.0.rename(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WatchlistOutput) -> Option<String> {
        Some(words(&o.list))
    }
}

struct Delete(Arc<WatchlistService>);

#[async_trait]
impl Tool for Delete {
    type Input = WatchlistsDeleteInput;
    type Output = WatchlistsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.delete", "Delete a watchlist", RiskTier::Modify)
            .description("Deletes watchlist `id` (watchlists.list) with its symbols. The last one may go too (the Markets area then offers New watchlist).")
            .activity("Deleted a watchlist")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WatchlistsDeleteInput,
    ) -> Result<WatchlistsOutput, ToolError> {
        self.0.delete(&input.id, &ctx.origin).await
    }

    fn summarize(&self, o: &WatchlistsOutput) -> Option<String> {
        Some(format!("{} left", lists_words(o)))
    }
}

struct Add(Arc<WatchlistService>);

#[async_trait]
impl Tool for Add {
    type Input = WatchlistsAddInput;
    type Output = WatchlistOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.add", "Add to a watchlist", RiskTier::Modify)
            .description(format!("Adds `instruments` to watchlist `id` (default: the first list), in their order, at index `at` (default: the end); one the list already holds stays where it is. {SYMBOLS}"))
            .activity("Added to a watchlist")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WatchlistsAddInput,
    ) -> Result<WatchlistOutput, ToolError> {
        self.0.add(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WatchlistOutput) -> Option<String> {
        Some(words(&o.list))
    }
}

struct Remove(Arc<WatchlistService>);

#[async_trait]
impl Tool for Remove {
    type Input = WatchlistsRemoveInput;
    type Output = WatchlistOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.remove", "Remove from a watchlist", RiskTier::Modify)
            .description("Takes `instruments` out of watchlist `id` (default: the first list), written as the list holds them (watchlists.list); ones it does not hold are ignored, but a call naming none it holds is refused.")
            .activity("Removed from a watchlist")
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WatchlistsRemoveInput,
    ) -> Result<WatchlistOutput, ToolError> {
        self.0.remove(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WatchlistOutput) -> Option<String> {
        Some(words(&o.list))
    }
}

struct Move(Arc<WatchlistService>);

#[async_trait]
impl Tool for Move {
    type Input = WatchlistsMoveInput;
    type Output = WatchlistsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("watchlists.move", "Reorder a watchlist", RiskTier::Modify)
            .description("Reorders, as dragging in the Markets area does: with `instrument`, moves that symbol within watchlist `id` to index `to` (0 first; past the end: last); without, moves list `id` itself to position `to` among the lists.")
            .activity("Reordered a watchlist")
            .idempotent(true)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: WatchlistsMoveInput,
    ) -> Result<WatchlistsOutput, ToolError> {
        self.0.move_(input, &ctx.origin).await
    }

    fn summarize(&self, o: &WatchlistsOutput) -> Option<String> {
        Some(
            o.lists
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        )
    }
}

pub(crate) fn register(
    r: &mut ToolRegistry,
    w: &Arc<WatchlistService>,
) -> Result<(), RegistryError> {
    r.register(List(Arc::clone(w)))?;
    r.register(Create(Arc::clone(w)))?;
    r.register(Rename(Arc::clone(w)))?;
    r.register(Delete(Arc::clone(w)))?;
    r.register(Add(Arc::clone(w)))?;
    r.register(Remove(Arc::clone(w)))?;
    r.register(Move(Arc::clone(w)))?;
    Ok(())
}
