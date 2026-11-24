use tessera_core::Timestamp;
use tessera_core::session::SessionCalendar;
use tessera_store::ticks::Span;

use crate::io::PrintGap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Gaps(Vec<Span>);

impl Gaps {
    pub fn in_session(
        calendar: Option<SessionCalendar>,
        holes: impl IntoIterator<Item = Span>,
    ) -> Self {
        let parts = holes.into_iter().flat_map(|h| match calendar {
            Some(c) => session_parts(c, h),
            None => vec![h],
        });
        Self::coalesced(parts)
    }

    fn coalesced(spans: impl IntoIterator<Item = Span>) -> Self {
        let mut spans: Vec<Span> = spans.into_iter().filter(|s| !s.is_empty()).collect();
        spans.sort_by_key(|s| s.start);
        let mut out: Vec<Span> = Vec::with_capacity(spans.len());
        for s in spans {
            match out.last_mut() {
                Some(last) if last.end >= s.start => last.end = last.end.max(s.end),
                _ => out.push(s),
            }
        }
        Self(out)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn spans(&self) -> &[Span] {
        &self.0
    }

    pub fn touches(&self, s: Span) -> bool {
        let i = self.0.partition_point(|g| g.end <= s.start);
        self.0.get(i).is_some_and(|g| g.start < s.end)
    }

    #[must_use]
    pub fn within(&self, s: Span) -> Self {
        Self(
            self.0
                .iter()
                .map(|g| Span::new(g.start.max(s.start), g.end.min(s.end)))
                .filter(|g| !g.is_empty())
                .collect(),
        )
    }

    #[must_use]
    pub fn merged(self, other: Self) -> Self {
        if other.is_empty() {
            return self;
        }
        Self::coalesced(self.0.into_iter().chain(other.0))
    }

    pub fn wire(&self) -> Vec<PrintGap> {
        self.0
            .iter()
            .map(|g| PrintGap {
                from: Timestamp(g.start),
                to: Timestamp(g.end),
            })
            .collect()
    }
}

pub(crate) fn session_parts(calendar: SessionCalendar, hole: Span) -> Vec<Span> {
    if hole.is_empty() {
        return Vec::new();
    }
    let last = calendar.trade_date(Timestamp(hole.end - 1));
    let mut date = calendar.trade_date(Timestamp(hole.start));
    let mut out = Vec::new();
    while date <= last {
        if let Some(s) = calendar.session(date) {
            out.extend(
                s.segments
                    .iter()
                    .map(|w| Span::new(w.start.0.max(hole.start), w.end.0.min(hole.end)))
                    .filter(|p| !p.is_empty()),
            );
        }
        let Some(next) = date.succ_opt() else { break };
        date = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use tessera_core::time::local_to_timestamp;

    use super::*;

    const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;

    fn at(d: u32, h: u32, m: u32) -> i64 {
        local_to_timestamp(
            CAL.tz(),
            NaiveDate::from_ymd_opt(2026, 10, d).unwrap(),
            h,
            m,
        )
        .0
    }

    #[test]
    fn a_hole_over_days_is_every_session_part_of_it_and_never_closed_hours() {
        let parts = session_parts(CAL, Span::new(at(1, 16, 0), at(5, 1, 0)));
        assert_eq!(
            parts,
            vec![
                Span::new(at(1, 16, 0), at(1, 17, 0)),
                Span::new(at(1, 18, 0), at(2, 17, 0)),
                Span::new(at(4, 18, 0), at(5, 1, 0)),
            ]
        );
        assert_eq!(
            session_parts(CAL, Span::new(at(2, 17, 0), at(4, 18, 0))),
            Vec::<Span>::new(),
            "Friday's close to Sunday's open"
        );
    }

    #[test]
    fn gaps_say_which_spans_they_touch_and_clip_to_a_read() {
        let gaps = Gaps::in_session(
            Some(CAL),
            [
                Span::new(at(1, 10, 0), at(1, 11, 0)),
                Span::new(at(1, 10, 30), at(1, 12, 0)),
                Span::new(at(2, 9, 0), at(2, 9, 30)),
            ],
        );
        assert_eq!(
            gaps.spans(),
            &[
                Span::new(at(1, 10, 0), at(1, 12, 0)),
                Span::new(at(2, 9, 0), at(2, 9, 30)),
            ]
        );
        assert!(gaps.touches(Span::new(at(1, 11, 55), at(1, 12, 5))));
        assert!(!gaps.touches(Span::new(at(1, 12, 0), at(1, 12, 5))));
        assert!(!gaps.touches(Span::new(at(1, 9, 55), at(1, 10, 0))));
        assert_eq!(
            gaps.within(Span::new(at(1, 11, 0), at(2, 9, 10))).spans(),
            &[
                Span::new(at(1, 11, 0), at(1, 12, 0)),
                Span::new(at(2, 9, 0), at(2, 9, 10)),
            ]
        );
    }
}
