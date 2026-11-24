#[macro_export]
macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(
            Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash,
            ::serde::Serialize, ::serde::Deserialize, ::ts_rs::TS, ::schemars::JsonSchema,
        )]
        pub struct $name(pub String);

        impl $name {
            pub const PREFIX: &'static str = $prefix;

            pub fn generate() -> Self {
                Self($crate::ids::unique(concat!($prefix, "_")))
            }

            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

string_id!(
    /// A trading account (`paper-main`, `rtest-01`).
    AccountId,
    "acct"
);
string_id!(
    /// A group of accounts traded together.
    AccountGroupId,
    "grp"
);
string_id!(
    /// A broker order.
    OrderId,
    "ord"
);
string_id!(
    /// An execution.
    FillId,
    "fill"
);
string_id!(
    /// An order draft awaiting approval (`d_51c2`).
    DraftId,
    "d"
);
string_id!(
    /// An approval request.
    ApprovalId,
    "apr"
);
string_id!(
    /// One tool invocation.
    CallId,
    "call"
);
string_id!(
    /// An agent session (`S15`).
    SessionId,
    "ses"
);
string_id!(
    /// A configured connection to an external system.
    ConnectionId,
    "conn"
);
string_id!(
    /// A broker / FCM.
    BrokerId,
    "brk"
);
string_id!(
    /// A data, intelligence, broker or agent provider instance.
    ProviderId,
    "prov"
);
string_id!(
    /// A prop-firm or funding provider.
    FundingProviderId,
    "fund"
);
string_id!(
    /// A funding program (e.g. a 50K evaluation).
    ProgramId,
    "prog"
);
string_id!(
    /// A versioned rule set.
    RuleSetId,
    "rules"
);
string_id!(
    /// A workspace note.
    NoteId,
    "note"
);

pub fn unique(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::now_v7().simple())
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}

pub fn numbered<'a>(base: &'a str, separator: &'a str) -> impl Iterator<Item = String> + 'a {
    std::iter::once(base.to_owned()).chain((2u64..).map(move |n| format!("{base}{separator}{n}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_prefixed_unique_and_ordered() {
        let a = ApprovalId::generate();
        let b = ApprovalId::generate();
        assert!(a.as_str().starts_with("apr_"));
        assert_ne!(a, b);
        assert!(a < b, "uuidv7 ids sort by creation time");
        assert_eq!(
            serde_json::to_string(&DraftId::new("d_51c2")).unwrap(),
            "\"d_51c2\""
        );
    }

    #[test]
    fn a_slug_keeps_letters_and_digits_joined_by_single_dashes() {
        assert_eq!(slug("Classic"), "classic");
        assert_eq!(slug(" Order Flow "), "order-flow");
        assert_eq!(slug("--Apex  Trader__Funding--"), "apex-trader-funding");
        assert_eq!(slug("Été 2026"), "t-2026");
        assert_eq!(slug("!!"), "");
    }

    #[test]
    fn numbered_names_start_bare_then_count_from_two() {
        let ids: Vec<String> = numbered("day", "-").take(3).collect();
        assert_eq!(ids, ["day", "day-2", "day-3"]);
        assert_eq!(numbered("Day copy", " ").nth(1).unwrap(), "Day copy 2");
    }

    #[test]
    fn a_unique_id_keeps_the_whole_uuid() {
        let id = unique("tag-");
        assert_eq!(id.len(), "tag-".len() + 32);
        assert_ne!(id, unique("tag-"));
    }
}
