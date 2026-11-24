use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::{numbered, slug};
use tessera_protocol::watchlists::{
    ID_MAX, KEY, LISTS_MAX, NAME_MAX, SYMBOL_MAX, SYMBOLS_MAX, Watchlist, WatchlistOutput,
    WatchlistsAddInput, WatchlistsCreateInput, WatchlistsMoveInput, WatchlistsOutput,
    WatchlistsRemoveInput, WatchlistsRenameInput,
};
use tessera_tools::ToolError;

use crate::settings::SettingsService;

const SLUG_MAX: usize = 40;

pub fn default_value() -> Value {
    json!({"lists": [{"id": "main", "name": "Watchlist", "symbols": ["NQ", "ES", "MNQ", "MES", "RTY", "YM", "CL", "GC"]}]})
}

pub fn schema() -> Value {
    let list = json!({"type": "object", "additionalProperties": false, "required": ["id", "name"], "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": ID_MAX},
        "name": {"type": "string", "minLength": 1, "maxLength": NAME_MAX},
        "symbols": {"type": "array", "maxItems": SYMBOLS_MAX, "items": {"type": "string", "minLength": 1, "maxLength": SYMBOL_MAX}},
    }});
    json!({"type": "object", "additionalProperties": false, "properties": {
        "lists": {"type": "array", "maxItems": LISTS_MAX, "items": list},
    }})
}

pub fn check(value: &Value) -> Result<(), String> {
    let lists = read(value);
    for (i, l) in lists.iter().enumerate() {
        if lists[..i].iter().any(|o| o.id == l.id) {
            return Err(format!("two watchlists have the id {}", l.id));
        }
    }
    Ok(())
}

pub fn read(value: &Value) -> Vec<Watchlist> {
    value
        .get("lists")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|l| serde_json::from_value(l.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn ids(lists: &[Watchlist]) -> String {
    if lists.is_empty() {
        "there are none".to_owned()
    } else {
        lists
            .iter()
            .map(|l| l.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

pub fn unknown(id: &str, lists: &[Watchlist]) -> ToolError {
    ToolError::not_found(format!("no watchlist {id} (ids: {})", ids(lists)))
}

fn new_id<'a>(name: &str, taken: impl Iterator<Item = &'a str> + Clone) -> String {
    let mut short = slug(name);
    short.truncate(SLUG_MAX);
    let short = short.trim_end_matches('-');
    let base = if short.is_empty() { "list" } else { short };
    numbered(base, "-")
        .find(|id| taken.clone().all(|t| t != id))
        .expect("unbounded")
}

fn clean_name(name: &str, lists: &[Watchlist], except: Option<&str>) -> Result<String, ToolError> {
    let name = name.trim();
    let len = name.chars().count();
    if len == 0 || len > NAME_MAX {
        return Err(ToolError::invalid_input(format!(
            "a watchlist's name is 1 to {NAME_MAX} characters"
        )));
    }
    if let Some(other) = lists
        .iter()
        .find(|l| Some(l.id.as_str()) != except && l.name.to_lowercase() == name.to_lowercase())
    {
        return Err(ToolError::invalid_input(format!(
            "a watchlist is already named {} (id {}): pick another name",
            other.name, other.id
        )));
    }
    Ok(name.to_owned())
}

fn clean_symbols(symbols: &[String]) -> Result<Vec<String>, ToolError> {
    let mut out: Vec<String> = Vec::new();
    for s in symbols {
        let s = s.trim();
        if s.is_empty() || out.iter().any(|o| o == s) {
            continue;
        }
        if s.chars().count() > SYMBOL_MAX {
            return Err(ToolError::invalid_input(format!(
                "a symbol is at most {SYMBOL_MAX} characters: {s}"
            )));
        }
        out.push(s.to_owned());
    }
    Ok(out)
}

fn too_many(name: &str, n: usize) -> ToolError {
    ToolError::invalid_input(format!(
        "a watchlist holds at most {SYMBOLS_MAX} symbols; {name} would hold {n}"
    ))
}

fn move_item<T>(items: &mut Vec<T>, from: usize, to: u32) {
    let item = items.remove(from);
    let to = (to as usize).min(items.len());
    items.insert(to, item);
}

pub struct WatchlistService {
    settings: Arc<SettingsService>,
    writes: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for WatchlistService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchlistService").finish_non_exhaustive()
    }
}

impl WatchlistService {
    pub fn new(settings: Arc<SettingsService>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            writes: tokio::sync::Mutex::new(()),
        })
    }

    pub fn lists(&self) -> Vec<Watchlist> {
        read(&self.settings.value(KEY).unwrap_or(Value::Null))
    }

    pub fn list(&self) -> WatchlistsOutput {
        WatchlistsOutput {
            lists: self.lists(),
        }
    }

    async fn store(&self, lists: &[Watchlist], origin: &Origin) -> Result<(), ToolError> {
        let value = json!({ "lists": lists });
        self.settings.set(KEY, value, origin).await.map(|_| ())
    }

    fn index(lists: &[Watchlist], id: Option<&str>) -> Result<usize, ToolError> {
        match id.map(str::trim).filter(|i| !i.is_empty()) {
            Some(id) => lists
                .iter()
                .position(|l| l.id == id)
                .ok_or_else(|| unknown(id, lists)),
            None if lists.is_empty() => Err(ToolError::not_found(
                "there is no watchlist: create one with watchlists.create",
            )),
            None => Ok(0),
        }
    }

    pub async fn create(
        &self,
        input: WatchlistsCreateInput,
        origin: &Origin,
    ) -> Result<WatchlistOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let mut lists = self.lists();
        let name = clean_name(&input.name, &lists, None)?;
        if lists.len() >= LISTS_MAX {
            return Err(ToolError::invalid_input(format!(
                "at most {LISTS_MAX} watchlists: delete one first"
            )));
        }
        let symbols = clean_symbols(input.symbols.as_deref().unwrap_or_default())?;
        if symbols.len() > SYMBOLS_MAX {
            return Err(too_many(&name, symbols.len()));
        }
        let id = new_id(&name, lists.iter().map(|l| l.id.as_str()));
        let list = Watchlist { id, name, symbols };
        lists.push(list.clone());
        self.store(&lists, origin).await?;
        Ok(WatchlistOutput { list, lists })
    }

    pub async fn rename(
        &self,
        input: WatchlistsRenameInput,
        origin: &Origin,
    ) -> Result<WatchlistOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let mut lists = self.lists();
        let i = Self::index(&lists, Some(&input.id))?;
        let name = clean_name(&input.name, &lists, Some(&lists[i].id))?;
        if lists[i].name != name {
            lists[i].name = name;
            self.store(&lists, origin).await?;
        }
        Ok(WatchlistOutput {
            list: lists[i].clone(),
            lists,
        })
    }

    pub async fn delete(&self, id: &str, origin: &Origin) -> Result<WatchlistsOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let mut lists = self.lists();
        let i = Self::index(&lists, Some(id))?;
        lists.remove(i);
        self.store(&lists, origin).await?;
        Ok(WatchlistsOutput { lists })
    }

    pub async fn add(
        &self,
        input: WatchlistsAddInput,
        origin: &Origin,
    ) -> Result<WatchlistOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let mut lists = self.lists();
        let i = Self::index(&lists, input.id.as_deref())?;
        let given = clean_symbols(&input.instruments)?;
        if given.is_empty() {
            return Err(ToolError::invalid_input(
                "name the symbols to add in instruments",
            ));
        }
        let list = &mut lists[i];
        let new: Vec<String> = given
            .into_iter()
            .filter(|s| !list.symbols.contains(s))
            .collect();
        if !new.is_empty() {
            let n = list.symbols.len() + new.len();
            if n > SYMBOLS_MAX {
                return Err(too_many(&list.name, n));
            }
            let at = input
                .at
                .map_or(list.symbols.len(), |a| (a as usize).min(list.symbols.len()));
            list.symbols.splice(at..at, new);
            self.store(&lists, origin).await?;
        }
        Ok(WatchlistOutput {
            list: lists[i].clone(),
            lists,
        })
    }

    pub async fn remove(
        &self,
        input: WatchlistsRemoveInput,
        origin: &Origin,
    ) -> Result<WatchlistOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let mut lists = self.lists();
        let i = Self::index(&lists, input.id.as_deref())?;
        let given = clean_symbols(&input.instruments)?;
        if given.is_empty() {
            return Err(ToolError::invalid_input(
                "name the symbols to remove in instruments",
            ));
        }
        let list = &mut lists[i];
        let before = list.symbols.len();
        list.symbols.retain(|s| !given.contains(s));
        if list.symbols.len() == before {
            return Err(ToolError::not_found(format!(
                "{} holds none of {} (it holds {})",
                list.name,
                given.join(", "),
                if list.symbols.is_empty() {
                    "nothing".to_owned()
                } else {
                    list.symbols.join(", ")
                }
            )));
        }
        self.store(&lists, origin).await?;
        Ok(WatchlistOutput {
            list: lists[i].clone(),
            lists,
        })
    }

    pub async fn move_(
        &self,
        input: WatchlistsMoveInput,
        origin: &Origin,
    ) -> Result<WatchlistsOutput, ToolError> {
        let _serial = self.writes.lock().await;
        let mut lists = self.lists();
        let i = Self::index(&lists, Some(&input.id))?;
        match input
            .instrument
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(symbol) => {
                let list = &mut lists[i];
                let from = list
                    .symbols
                    .iter()
                    .position(|s| s == symbol)
                    .ok_or_else(|| {
                        ToolError::not_found(format!("{} does not hold {symbol}", list.name))
                    })?;
                move_item(&mut list.symbols, from, input.to);
            }
            None => move_item(&mut lists, i, input.to),
        }
        self.store(&lists, origin).await?;
        Ok(WatchlistsOutput { lists })
    }
}

pub async fn migrate_preferences_watchlist(
    settings: &Arc<SettingsService>,
) -> Result<(), ToolError> {
    if settings.stored(KEY).is_some() {
        return Ok(());
    }
    let Some(Value::Array(old)) = settings
        .stored("ui.preferences")
        .and_then(|p| p.get("watchlist").cloned())
    else {
        return Ok(());
    };
    let strings: Vec<String> = old
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| s.trim().chars().count() <= SYMBOL_MAX)
        .map(str::to_owned)
        .collect();
    let mut symbols = clean_symbols(&strings)?;
    symbols.truncate(SYMBOLS_MAX);
    let value = json!({"lists": [{"id": "main", "name": "Watchlist", "symbols": symbols}]});
    settings.set(KEY, value, &Origin::User).await?;
    tracing::info!("the watchlist moved into markets.watchlists");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_the_names_slug_made_unique() {
        let none: [&str; 0] = [];
        assert_eq!(new_id("Futures", none.iter().copied()), "futures");
        assert_eq!(
            new_id("  Tech -- Large caps!  ", none.iter().copied()),
            "tech-large-caps"
        );
        assert_eq!(new_id("€€€", none.iter().copied()), "list");
        assert_eq!(
            new_id(&"x".repeat(60), none.iter().copied()).len(),
            SLUG_MAX
        );
        let taken = ["futures", "futures-2"];
        assert_eq!(new_id("FUTURES", taken.iter().copied()), "futures-3");
    }

    #[test]
    fn symbols_are_trimmed_and_kept_once() {
        let got = clean_symbols(&[" NQ ".into(), "".into(), "ES".into(), "NQ".into()]).unwrap();
        assert_eq!(got, ["NQ", "ES"]);
        assert!(clean_symbols(&["X".repeat(65)]).is_err());
    }

    #[test]
    fn the_default_is_valid_and_ids_are_unique() {
        let s = schema();
        crate::settings::validate(&s, &default_value()).unwrap();
        assert!(check(&default_value()).is_ok());
        let twice = json!({"lists": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]});
        assert!(check(&twice).is_err());
        for bad in [
            json!({"lists": [{"id": "", "name": "A"}]}),
            json!({"lists": [{"id": "a", "name": "x".repeat(41)}]}),
            json!({"lists": [{"id": "a", "name": "A", "symbols": [""]}]}),
            json!({"lists": [{"id": "a", "name": "A", "colour": "red"}]}),
            json!({"watchlists": []}),
        ] {
            assert!(crate::settings::validate(&s, &bad).is_err(), "{bad}");
        }
    }
}
