use chrono::NaiveDate;
use tessera_core::Timestamp;
use tessera_core::accounts::Environment;
use tessera_core::limits::LimitsStatus;
use tessera_core::money::Money;
use tessera_core::session::SessionCalendar;
use tessera_protocol::agent::{AgentEvent, AgentEventEnvelope};
use tessera_protocol::cards::{SessionIssue, SessionTrade, TradingSessionReport};
use tessera_protocol::tools::{ToolErrorInfo, ToolOutcome};
use tessera_research::StudySignal;
use tessera_research::study::Study;
use tessera_research::tools::RunDigest;

pub const FRICTION: &str = "## Friction";

#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub environment: Environment,
    pub limits: Option<LimitsStatus>,
}

pub const CALENDAR: SessionCalendar = SessionCalendar::CmeEquityIndex;

pub fn clock(at: Timestamp) -> String {
    at.to_datetime()
        .with_timezone(&CALENDAR.tz())
        .format("%H:%M")
        .to_string()
}

pub fn moment(at: Timestamp) -> String {
    at.to_datetime()
        .with_timezone(&CALENDAR.tz())
        .format("%a %-d %b %H:%M")
        .to_string()
}

pub fn zone() -> String {
    let name = CALENDAR.tz().name();
    name.rsplit('/').next().unwrap_or(name).replace('_', " ")
}

pub fn day_words(date: NaiveDate) -> String {
    date.format("%a %-d %b %Y").to_string()
}

fn usd(m: &Money) -> String {
    format!("${:.2}", m.amount)
}

pub fn limit_lines(limits: Option<&LimitsStatus>) -> Vec<String> {
    let Some(l) = limits else {
        return vec!["- none set".into()];
    };
    let mut out = Vec::new();
    if let Some(d) = &l.daily_loss_limit {
        let left = l
            .daily_loss_left
            .as_ref()
            .map(|left| format!(", {} left today", usd(left)))
            .unwrap_or_default();
        out.push(format!("- daily loss limit {}{left}", usd(d)));
    }
    if let Some(r) = &l.max_risk_per_trade {
        out.push(format!(
            "- max risk per trade {} at the stop: every entry needs a stop",
            usd(r)
        ));
    }
    if let Some(n) = l.max_position_qty {
        out.push(format!("- at most {n} contracts held in a contract"));
    }
    if let Some(n) = l.max_order_qty {
        out.push(format!("- at most {n} contracts an order"));
    }
    if let Some(n) = l.max_trades_per_day {
        let so_far = l
            .trades_today
            .map(|t| format!(" ({t} so far)"))
            .unwrap_or_default();
        out.push(format!("- at most {n} trades today{so_far}"));
    }
    if let Some(room) = &l.firm_room {
        out.push(format!(
            "- the firm's rules leave {} (its trailing drawdown and daily loss, as its platform reports them)",
            usd(room)
        ));
    }
    if let Some(why) = l.locked_why.as_deref().filter(|_| l.locked) {
        out.push(format!("- new positions are refused now: {why}"));
    }
    out
}

pub struct Traded<'a> {
    pub study: &'a Study,
    pub latest: Option<&'a RunDigest>,
    pub signal: &'a StudySignal,
}

pub fn opening(
    date: NaiveDate,
    now: Timestamp,
    wrap: Timestamp,
    close: Timestamp,
    account: &Account,
    instructions: Option<(&str, &str)>,
    traded: Option<&Traded<'_>>,
) -> String {
    let decides = match (traded.is_some(), instructions.is_some()) {
        (true, true) => {
            "the Research study below decides what you trade, and the user's standing instructions below add how and when"
        }
        (true, false) => "the Research study below decides what you trade",
        (false, _) => "the user's standing instructions below decide when and what you trade",
    };
    let mut s = format!(
        "Tessera started this trading session for the user at {now}: the trading day of {day}, \
         while the market is open, up to its next break at {close} (times are {zone} time). You \
         trade it on your own, and {decides}.\n\n\
         Account: {name} ({id}), {env}. Trade this account only. Your orders go without asking \
         (full access), under the account's limits, which Tessera enforces and only the user changes:\n\
         {limits}\n\n\
         Between turns you sleep. The alerts you set (alerts_create) wake you when they fire, and \
         agent_wake_at wakes you at a time, such as when the hours your instructions name begin; \
         nothing else does: before you end a turn, leave alerts or a wake for what you are waiting \
         for. At {wrap} Tessera asks you to close out and write your log; at {close} it cancels the \
         account's working orders and closes its positions.",
        day = day_words(date),
        now = moment(now),
        close = moment(close),
        wrap = moment(wrap),
        zone = zone(),
        name = account.name,
        id = account.id,
        env = account.environment.label(),
        limits = limit_lines(account.limits.as_ref()).join("\n"),
    );
    if let Some(t) = traded {
        s.push_str("\n\n");
        s.push_str(&study_lines(t));
    }
    if let Some((path, text)) = instructions {
        s.push_str(&format!(
            "\n\nThe user's standing instructions (from {path}):\n\n{}",
            text.trim()
        ));
    }
    s
}

fn study_lines(t: &Traded<'_>) -> String {
    let st = t.study;
    let frozen = st.manifest_hash.as_deref().map_or(String::new(), |h| {
        format!(", frozen as {}", &h[..h.len().min(8)])
    });
    let measured = t.latest.map_or_else(
        || "It has not been run on history yet: nothing about it is measured.".to_owned(),
        measured,
    );
    format!(
        "The strategy: the Research study \"{name}\" ({id}, generation {generation}{frozen}) on {instrument}, {tf} bars. Its hypothesis, as registered: {hypothesis}\n\
         {measured}\n\n\
         Its signal is the position the study holds after each closed bar; research_study_signal reads it at any time. Now: {now}. Tessera reads it at each close of its bars and wakes you when it changes. Bring the account's {instrument} position to it, with its stop and target, under the account's limits; where the limits, the market or the instructions stop you, say so in your log rather than trade around them. At the close Tessera files the session's trades in the journal under the setup \"{name}\", linked to the study.",
        name = st.name,
        id = st.id,
        generation = st.generation,
        instrument = st.data.instrument,
        tf = st.data.tf,
        hypothesis = st.hypothesis.trim(),
        now = signal_words(t.signal),
    )
}

fn measured(r: &RunDigest) -> String {
    let kind = if r.exploratory {
        "exploratory run, on a draft"
    } else {
        "run"
    };
    let (trades, net) = r.cases.first().map_or((0, 0.0), |c| {
        (
            c.development.trades + c.later.trades,
            c.development.net_pnl + c.later.net_pnl,
        )
    });
    format!(
        "Its latest {kind} measured {trades} trades over {sessions} sessions of history, net {net} in the base fill case; verdict {verdict}: {reason} That measures the past, not what it will do today.",
        sessions = r.sessions,
        net = money(net),
        verdict = format!("{:?}", r.verdict).to_lowercase(),
        reason = r.reason.trim(),
    )
}

fn contracts(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{v:.0}")
    } else {
        format!("{v}")
    }
}

pub fn position_words(p: f64) -> String {
    if p > 0.0 {
        format!("long {}", contracts(p))
    } else if p < 0.0 {
        format!("short {}", contracts(-p))
    } else {
        "flat".into()
    }
}

fn bracket_words(s: &StudySignal) -> String {
    match (s.stop_distance, s.target_distance) {
        (Some(stop), Some(target)) => {
            format!(", stop {stop} and target {target} in price from the fill")
        }
        (Some(stop), None) => format!(", stop {stop} in price from the fill"),
        (None, Some(target)) => format!(", target {target} in price from the fill"),
        (None, None) => String::new(),
    }
}

pub fn signal_words(s: &StudySignal) -> String {
    if s.levels_missing {
        return "flat: its level inputs have no values in this session yet".into();
    }
    let mut w = position_words(s.position);
    if s.position == 0.0 {
        return w;
    }
    if let Some(at) = s.decided_at {
        w.push_str(&format!(" since the {} bar", moment(at)));
    }
    w.push_str(&bracket_words(s));
    w.push_str(if s.reenters {
        ". It sets this on every bar, so after a stop or target it enters again at the next bar, as its backtest does"
    } else {
        ". It set this once, so after a stop or target it stays out until its position changes, as its backtest does"
    });
    w
}

pub fn signal_changed(s: &StudySignal, was: f64) -> String {
    format!(
        "Tessera: at the close of the {bar} bar the study \"{name}\" went from {was} to {now}{bracket}. Bring the account's {instrument} position to it under the account's limits, or say in your log why not.",
        bar = clock(s.bar_at),
        name = s.name,
        was = position_words(was),
        now = position_words(s.position),
        bracket = if s.position == 0.0 {
            String::new()
        } else {
            bracket_words(s)
        },
        instrument = s.instrument,
    )
}

pub fn study_changed(name: &str) -> String {
    format!(
        "Tessera: the study \"{name}\" was changed in Research, so this session no longer follows its signal. Close the position you hold for it and trade nothing more of it this session."
    )
}

const MONTH_CODES: &str = "FGHJKMNQUVXZ";

pub fn root(symbol: &str) -> &str {
    let undated = symbol.trim_end_matches(|c: char| c.is_ascii_digit());
    match undated.char_indices().last() {
        Some((at, month))
            if undated.len() < symbol.len() && at > 0 && MONTH_CODES.contains(month) =>
        {
            &undated[..at]
        }
        _ => symbol,
    }
}

pub fn traded_line(name: &str) -> String {
    format!("Traded the Research study \"{name}\".")
}

pub fn closing(wrap: Timestamp, close: Timestamp, account: &Account) -> String {
    format!(
        "It is {wrap} {zone} time and the market breaks at {close}: the session is over. Close what is open on {name}, cancel its \
         working orders and pause the alerts you set today. Then write your log for the user: what \
         you did and why, trade by trade, and the setups you passed on. End it with a section \
         \"{FRICTION}\" listing every failure or friction you met in Tessera today, one a line as \
         \"- <short title>: <what happened>\", or \"- none\". Answer with the log here: Tessera \
         writes it into the journal's day and files each friction as an issue, so do not save it \
         yourself.",
        wrap = moment(wrap),
        close = clock(close),
        zone = zone(),
        name = account.name,
    )
}

pub fn woken(now: Timestamp, note: &str) -> String {
    format!(
        "It is {now} {zone} time: the wake you set (agent_wake_at). Your note: {note}",
        now = moment(now),
        zone = zone(),
    )
}

pub fn last_answer(events: &[AgentEventEnvelope], since: Timestamp) -> Option<String> {
    events
        .iter()
        .rev()
        .take_while(|e| e.ts >= since)
        .find_map(|e| match &e.event {
            AgentEvent::AssistantMessage { text, .. } if !text.trim().is_empty() => {
                Some(text.clone())
            }
            _ => None,
        })
}

pub fn frictions(log: &str) -> Vec<SessionIssue> {
    let Some(at) = log.find(FRICTION) else {
        return Vec::new();
    };
    log[at + FRICTION.len()..]
        .lines()
        .take_while(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.trim().strip_prefix("- "))
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.eq_ignore_ascii_case("none"))
        .map(|l| {
            let (title, detail) = l.split_once(": ").unwrap_or((l, ""));
            issue(title, detail, "analyst")
        })
        .collect()
}

pub fn log_body(log: &str) -> String {
    log.find(FRICTION)
        .map_or(log, |at| &log[..at])
        .trim()
        .to_owned()
}

fn issue(title: &str, detail: &str, from: &str) -> SessionIssue {
    SessionIssue {
        title: title.trim().trim_end_matches('.').to_owned(),
        detail: detail.trim().to_owned(),
        from: from.into(),
        url: None,
        not_filed: None,
    }
}

fn held_by_limits(e: &ToolErrorInfo) -> bool {
    e.details
        .as_ref()
        .and_then(|d| d.get("code"))
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.starts_with("limit_") || c == "firm_rules")
}

pub fn failures(events: &[AgentEventEnvelope]) -> Vec<SessionIssue> {
    let mut out: Vec<SessionIssue> = Vec::new();
    let mut push = |i: SessionIssue| {
        if !out.iter().any(|o| o.title == i.title) {
            out.push(i);
        }
    };
    for e in events {
        match &e.event {
            AgentEvent::ToolCallFinished {
                tool,
                outcome,
                error,
                ..
            } => match (outcome, error) {
                (ToolOutcome::Ok, _) => {}
                (_, Some(err)) if held_by_limits(err) => {}
                (ToolOutcome::PendingApproval, _) => push(issue(
                    &format!("{tool} waited on an approval in a full-access session"),
                    "The call was held for the user's approval, which nobody gives while the analyst trades on its own.",
                    "tessera",
                )),
                (_, Some(err)) => push(issue(
                    &format!("{tool}: {}", first_line(&err.message)),
                    &format!("{:?}: {}", err.code, err.message),
                    "tessera",
                )),
                (_, None) => push(issue(&format!("{tool} failed"), "", "tessera")),
            },
            AgentEvent::Error { code, message, .. } => push(issue(
                &format!("The analyst's {code} failed: {}", first_line(message)),
                message,
                "tessera",
            )),
            _ => {}
        }
    }
    out
}

pub fn runner_issue(title: &str, detail: &str) -> SessionIssue {
    issue(title, detail, "tessera")
}

fn first_line(s: &str) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    let mut out: String = line.chars().take(90).collect();
    if line.chars().count() > 90 {
        out.push('…');
    }
    out
}

pub fn issue_title(i: &SessionIssue) -> String {
    format!("Analyst session: {}", i.title)
}

pub fn issue_body(i: &SessionIssue, r: &TradingSessionReport, session: &str) -> String {
    let scrub = |s: &str| {
        let mut s = s.replace(&r.account_id, "the account");
        if r.account_name.len() > 2 {
            s = s.replace(&r.account_name, "the account");
        }
        s
    };
    let found = if i.from == "analyst" {
        "The analyst reported it in its session log."
    } else {
        "Tessera recorded it during the session."
    };
    let detail = if i.detail.is_empty() {
        String::new()
    } else {
        format!("{}\n\n", scrub(&i.detail))
    };
    format!(
        "{detail}{found}\n\n- Session: {date}, {env} account\n- Conversation: {session}\n\n\
         Filed by Tessera's session runner.",
        date = r.date,
        env = r.environment.label(),
    )
}

fn price(v: f64, decimals: u32) -> String {
    format!("{v:.prec$}", prec = decimals as usize)
}

fn money(v: f64) -> String {
    if v < 0.0 {
        format!("-${:.2}", -v)
    } else {
        format!("${v:.2}")
    }
}

pub fn journal_heading(account_name: &str, later: Option<Timestamp>) -> String {
    match later {
        None => format!("### Analyst session · {account_name}"),
        Some(open) => format!(
            "### Analyst session · {account_name} · from {}",
            moment(open)
        ),
    }
}

pub fn journal_section(heading: &str, r: &TradingSessionReport) -> String {
    let mut s = heading.to_owned();
    s.push_str(&format!(
        "\n\n{}–{} {} · {} trade{} · net {}\n",
        clock(r.started_at),
        clock(r.ended_at),
        zone(),
        r.trades.len(),
        if r.trades.len() == 1 { "" } else { "s" },
        money(r.net_pnl)
    ));
    if !r.trades.is_empty() {
        s.push_str("\n| Opened | Market | Side | Qty | Entry | Exit | Net | R |\n");
        s.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
        for t in &r.trades {
            s.push_str(&trade_row(t));
        }
    }
    if !r.log.trim().is_empty() {
        s.push('\n');
        s.push_str(r.log.trim());
        s.push('\n');
    }
    if !r.issues.is_empty() {
        s.push_str("\nIssues:\n");
        for i in &r.issues {
            let at = i
                .url
                .clone()
                .or_else(|| i.not_filed.as_ref().map(|w| format!("not filed: {w}")))
                .unwrap_or_default();
            s.push_str(&format!("- {} ({at})\n", i.title));
        }
    }
    s
}

fn trade_row(t: &SessionTrade) -> String {
    format!(
        "| {} | {} | {} | {} | {} | {} | {} | {} |\n",
        clock(t.opened_at),
        t.symbol,
        if matches!(t.side, tessera_core::orders::Side::Buy) {
            "Long"
        } else {
            "Short"
        },
        t.qty,
        price(t.entry_price, t.price_decimals),
        t.exit_price
            .map_or_else(|| "open".into(), |p| price(p, t.price_decimals)),
        money(t.net_pnl),
        t.r_multiple
            .map_or_else(|| "–".into(), |r| format!("{r:.2}")),
    )
}

fn heading_at(content: &str, heading: &str) -> Option<usize> {
    content
        .match_indices(heading)
        .map(|(at, _)| at)
        .find(|&at| {
            let end = at + heading.len();
            (at == 0 || content[..at].ends_with('\n'))
                && (end == content.len() || content[end..].starts_with('\n'))
        })
}

pub fn with_section(content: &str, heading: &str, section: &str) -> String {
    let Some(at) = heading_at(content, heading) else {
        let content = content.trim_end();
        return if content.is_empty() {
            section.trim_end().to_owned()
        } else {
            format!("{content}\n\n{}", section.trim_end())
        };
    };
    let rest = &content[at + heading.len()..];
    let end = rest
        .find("\n### ")
        .map_or(content.len(), |i| at + heading.len() + i);
    let before = content[..at].trim_end();
    let after = content[end..].trim();
    let mut out = String::new();
    if !before.is_empty() {
        out.push_str(before);
        out.push_str("\n\n");
    }
    out.push_str(section.trim_end());
    if !after.is_empty() {
        out.push_str("\n\n");
        out.push_str(after);
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tessera_core::ids::{CallId, SessionId};
    use tessera_protocol::tools::{RiskTier, ToolErrorCode};

    use super::*;

    fn env(event: AgentEvent) -> AgentEventEnvelope {
        AgentEventEnvelope {
            session_id: SessionId::new("S1"),
            seq: 1,
            ts: Timestamp(0),
            turn_id: None,
            event,
        }
    }

    fn finished(tool: &str, outcome: ToolOutcome, error: Option<ToolErrorInfo>) -> AgentEvent {
        AgentEvent::ToolCallFinished {
            call_id: CallId::generate(),
            tool: tool.into(),
            risk: RiskTier::Financial,
            outcome,
            result_summary: None,
            artifact_refs: Vec::new(),
            duration_ms: 1.0,
            error,
            result: None,
        }
    }

    fn err(
        code: ToolErrorCode,
        message: &str,
        details: Option<serde_json::Value>,
    ) -> ToolErrorInfo {
        ToolErrorInfo {
            code,
            message: message.into(),
            details,
            retryable: false,
        }
    }

    #[test]
    fn the_log_s_friction_lines_are_its_issues_and_none_is_nothing() {
        let log = "Took one long at the open.\n\n## Friction\n- Quotes lagged: the DOM was 2 s behind.\n- portfolio_get_risk_status had no firm room\n\n# Later\n- not this";
        let f = frictions(log);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].title, "Quotes lagged");
        assert_eq!(f[0].detail, "the DOM was 2 s behind.");
        assert_eq!(f[0].from, "analyst");
        assert_eq!(f[1].title, "portfolio_get_risk_status had no firm room");
        assert_eq!(log_body(log), "Took one long at the open.");
        assert!(frictions("All quiet.\n\n## Friction\n- none\n").is_empty());
        assert!(frictions("No section at all").is_empty());
    }

    #[test]
    fn failed_calls_are_issues_but_the_limits_own_refusals_are_not() {
        let events = vec![
            env(finished("orders.submit", ToolOutcome::Ok, None)),
            env(finished(
                "orders.submit",
                ToolOutcome::Error,
                Some(err(
                    ToolErrorCode::Rejected,
                    "This stop risks $400: over your $300 a trade.",
                    Some(json!({"code": "limit_risk_per_trade"})),
                )),
            )),
            env(finished(
                "orders.submit",
                ToolOutcome::Error,
                Some(err(ToolErrorCode::Rejected, "No live prices for MNQ", None)),
            )),
            env(finished(
                "orders.submit",
                ToolOutcome::Error,
                Some(err(ToolErrorCode::Rejected, "No live prices for MNQ", None)),
            )),
            env(finished(
                "orders.create_draft",
                ToolOutcome::PendingApproval,
                None,
            )),
            env(AgentEvent::Error {
                code: "provider".into(),
                message: "codex exited".into(),
                retryable: true,
            }),
        ];
        let f = failures(&events);
        let titles: Vec<&str> = f.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "orders.submit: No live prices for MNQ",
                "orders.create_draft waited on an approval in a full-access session",
                "The analyst's provider failed: codex exited",
            ]
        );
    }

    #[test]
    fn the_journal_section_replaces_its_own_and_keeps_the_users_words() {
        let heading = journal_heading("Eval 50K", None);
        let first = format!("{heading}\n\nfirst run");
        let mine = "My notes.";
        let once = with_section(mine, &heading, &first);
        assert_eq!(once, format!("My notes.\n\n{first}"));
        let other = "### Analyst session · Paper\n\nthe other account";
        let both = with_section(
            &format!("{once}\n\n{other}"),
            &heading,
            &format!("{heading}\n\nsecond run"),
        );
        assert_eq!(
            both,
            format!("My notes.\n\n{heading}\n\nsecond run\n\n{other}")
        );
        assert_eq!(with_section("", &heading, &first), first);
        let later = journal_heading(
            "Eval 50K",
            Timestamp::parse("2026-11-26T18:00:00-05:00").ok(),
        );
        assert_eq!(later, format!("{heading} · from Thu 26 Nov 18:00"));
        let evening = format!("{later}\n\nafter the halt");
        let day = with_section(&with_section("", &heading, &first), &later, &evening);
        assert_eq!(
            with_section(&day, &heading, &format!("{heading}\n\nagain")),
            format!("{heading}\n\nagain\n\n{evening}")
        );
    }

    fn signal(position: f64, reenters: bool) -> StudySignal {
        StudySignal {
            study_id: "study-1".into(),
            name: "NQ 1m EMA 2/5".into(),
            generation: 1,
            manifest_hash: None,
            instrument: tessera_core::InstrumentId::new("NQZ6.CME").unwrap(),
            tf: tessera_core::Timeframe::M1,
            bar_at: Timestamp::parse("2026-10-02T09:41:00-04:00").unwrap(),
            position,
            decided_at: Some(Timestamp::parse("2026-10-02T09:35:00-04:00").unwrap()),
            stop_distance: Some(30.0),
            target_distance: Some(60.0),
            next_at: Timestamp::parse("2026-10-02T09:43:00-04:00").unwrap(),
            reenters,
            levels_missing: false,
        }
    }

    #[test]
    fn a_signal_reads_as_its_position_its_bracket_and_whether_it_enters_again() {
        let now = signal_words(&signal(-1.0, true));
        assert!(
            now.starts_with("short 1 since the Fri 2 Oct 09:35 bar, stop 30 and target 60 in price from the fill. It sets this on every bar"),
            "{now}"
        );
        assert!(signal_words(&signal(1.0, false)).contains("stays out until its position changes"));
        assert_eq!(signal_words(&signal(0.0, true)), "flat");
        assert_eq!(
            signal_changed(&signal(-1.0, true), 1.0),
            "Tessera: at the close of the 09:41 bar the study \"NQ 1m EMA 2/5\" went from long 1 to short 1, stop 30 and target 60 in price from the fill. Bring the account's NQZ6.CME position to it under the account's limits, or say in your log why not."
        );
        assert!(
            signal_changed(&signal(0.0, true), -1.0).contains("went from short 1 to flat. Bring")
        );
        let mut waiting = signal(1.0, true);
        waiting.levels_missing = true;
        assert_eq!(
            signal_words(&waiting),
            "flat: its level inputs have no values in this session yet"
        );
        assert!(study_changed("NQ 1m EMA 2/5").contains(
            "was changed in Research, so this session no longer follows its signal. Close the position"
        ));
        for (symbol, r) in [
            ("NQZ6", "NQ"),
            ("SILZ6", "SIL"),
            ("SI", "SI"),
            ("MNQH27", "MNQ"),
            ("AAPL", "AAPL"),
            ("Z6", "Z6"),
        ] {
            assert_eq!(root(symbol), r, "{symbol}");
        }
    }

    #[test]
    fn an_issue_never_names_the_account() {
        let r = TradingSessionReport {
            date: "2026-10-26".into(),
            account_id: "TEST-000001".into(),
            account_name: "TEST-000001".into(),
            environment: Environment::Eval,
            started_at: Timestamp(0),
            ended_at: Timestamp(0),
            trades: Vec::new(),
            net_pnl: 0.0,
            log: String::new(),
            issues: Vec::new(),
        };
        let i = issue("Flatten failed", "TEST-000001 kept 1 MNQ", "tessera");
        let body = issue_body(&i, &r, "S1");
        assert!(!body.contains("000001"), "{body}");
        assert!(body.contains("the account kept 1 MNQ"));
        assert!(body.contains("EVAL account"));
        assert_eq!(issue_title(&i), "Analyst session: Flatten failed");
    }
}
