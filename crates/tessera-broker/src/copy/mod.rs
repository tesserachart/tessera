mod accounts;
pub mod book;
pub mod io;
mod manage;
mod mirror;
pub mod model;
pub mod sync;
pub mod tools;

pub use accounts::{FLATTEN_TOOL, RESYNC_TOOL};
pub use book::{AccountFacts, CopyBook, STORE_KEY};
pub(crate) use mirror::CopyState;
pub use mirror::{COPY_TOOL, copies_words};
pub use model::{
    CopyFollower, CopyGroup, CopyGroupsUpdate, CopyNote, CopyOutcome, CopyReport, CopyResult,
};
pub use sync::{
    CopyActivity, CopyFollowerSync, CopyGroupSync, CopyHolding, CopyLast, CopySyncUpdate,
    LeaderHolding, SyncState,
};

pub const GROUPS_TOPIC: &str = "copy.groups";
pub const NOTES_TOPIC: &str = "copy.notes";
pub const SYNC_TOPIC: &str = "copy.sync";
