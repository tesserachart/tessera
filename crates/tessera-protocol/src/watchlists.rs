use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const KEY: &str = "markets.watchlists";
pub const LISTS_MAX: usize = 50;
pub const SYMBOLS_MAX: usize = 500;
pub const NAME_MAX: usize = 40;
pub const ID_MAX: usize = 64;
pub const SYMBOL_MAX: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Watchlist {
    /// Stable id (`main`, `futures`, `futures-2`); a rename keeps it.
    pub id: String,
    /// The user's name for it.
    pub name: String,
    /// Its symbols in the user's order, each as the user wrote it (`NQ` follows the front month; `NQZ6.CME` is that
    /// contract).
    #[serde(default)]
    pub symbols: Vec<String>,
}

/// `watchlists.list` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchlistsListInput {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WatchlistsCreateInput {
    /// Its name (1–40 characters; no other list may have it, in any case).
    pub name: String,
    /// Its symbols, in order (ids or symbols as the user writes them; empty and repeated ones are dropped).
    #[serde(default)]
    pub symbols: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchlistsRenameInput {
    /// The list's id (watchlists.list).
    pub id: String,
    /// Its new name (1–40 characters; no other list may have it).
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchlistsDeleteInput {
    /// The list's id (watchlists.list).
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WatchlistsAddInput {
    /// The list's id (default: the first list).
    #[serde(default)]
    pub id: Option<String>,
    /// The symbols to add, in order (ones already in the list stay where they are).
    pub instruments: Vec<String>,
    /// Where they go: the index of the first (default: the end).
    #[serde(default)]
    pub at: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WatchlistsRemoveInput {
    /// The list's id (default: the first list).
    #[serde(default)]
    pub id: Option<String>,
    /// The symbols to take out, as the list holds them.
    pub instruments: Vec<String>,
}

/// `watchlists.move` input: a symbol within a list, or the list among the lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WatchlistsMoveInput {
    /// The list's id (watchlists.list).
    pub id: String,
    /// The symbol to move within the list; omitted: the list itself moves among the lists.
    #[serde(default)]
    pub instrument: Option<String>,
    /// Its new index (0 first; past the end: last).
    pub to: u32,
}

/// What `watchlists.list`, `watchlists.delete` and `watchlists.move` return: every watchlist, in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistsOutput {
    /// The watchlists, in the user's order.
    pub lists: Vec<Watchlist>,
}

/// What `watchlists.create`, `watchlists.rename`, `watchlists.add` and `watchlists.remove` return: the list changed
/// and every watchlist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistOutput {
    /// The list as it is now.
    pub list: Watchlist,
    /// Every watchlist, in the user's order.
    pub lists: Vec<Watchlist>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_made_from_the_longest_name_fits() {
        let made = format!("{}-{}", "x".repeat(NAME_MAX), LISTS_MAX + 1);
        assert!(made.len() <= ID_MAX, "{made}");
    }
}
