use rust_decimal::Decimal;
use tessera_core::money::Price;
use tessera_core::time::{NANOS_PER_SEC, Timestamp};

const SHOWN_FIRST_KEPT: i64 = 30 * NANOS_PER_SEC;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Read {
    Update,
    Snapshot,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Unshown {
    fills: Vec<Decimal>,
    shown_first: Vec<(Decimal, Timestamp)>,
    pub last: Option<(Price, Timestamp)>,
}

impl Unshown {
    pub fn qty(&self) -> Decimal {
        self.fills.iter().sum()
    }

    pub fn filled(&mut self, qty: Decimal, price: Price, now: Timestamp) {
        self.last = Some((price, now));
        self.shown_first
            .retain(|(_, at)| now.0.saturating_sub(at.0) < SHOWN_FIRST_KEPT);
        let left = take(self.shown_first.iter_mut().map(|(q, _)| q), qty);
        self.shown_first.retain(|(q, _)| !q.is_zero());
        if !left.is_zero() {
            self.fills.push(left);
        }
        self.tidy();
    }

    pub fn shown(&mut self, moved: Decimal, now: Timestamp, read: Read) {
        let left = take(self.fills.iter_mut(), moved);
        self.fills.retain(|q| !q.is_zero());
        if !left.is_zero() && read == Read::Update {
            self.shown_first.push((left, now));
        }
        self.tidy();
    }

    fn tidy(&mut self) {
        if self.qty().is_zero() {
            self.fills.clear();
        }
    }
}

fn take<'a>(held: impl Iterator<Item = &'a mut Decimal>, want: Decimal) -> Decimal {
    let mut left = want;
    for q in held {
        if left.is_zero() {
            break;
        }
        if q.is_zero() || q.is_sign_positive() != left.is_sign_positive() {
            continue;
        }
        let part = if q.abs() <= left.abs() { *q } else { left };
        *q -= part;
        left -= part;
    }
    left
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(n: i64) -> Decimal {
        Decimal::from(n)
    }

    const PX: Price = Price(Decimal::ZERO);

    fn at(secs: i64) -> Timestamp {
        Timestamp(secs * NANOS_PER_SEC)
    }

    #[test]
    fn a_fill_counts_until_the_pnl_shows_it() {
        let mut u = Unshown::default();
        u.filled(d(-1), PX, at(0));
        assert_eq!(u.qty(), d(-1));
        u.shown(d(-1), at(1), Read::Update);
        assert_eq!(u.qty(), d(0));
    }

    #[test]
    fn a_fill_the_pnl_never_shows_keeps_counting() {
        let mut u = Unshown::default();
        u.filled(d(-1), PX, at(0));
        u.shown(d(0), at(100), Read::Update);
        assert_eq!(u.qty(), d(-1));
        u.filled(d(2), PX, at(200));
        assert_eq!(u.qty(), d(1));
    }

    #[test]
    fn a_pnl_ahead_of_its_fill_absorbs_the_fill_when_it_lands() {
        let mut u = Unshown::default();
        u.shown(d(-1), at(0), Read::Update);
        assert_eq!(u.qty(), d(0));
        u.filled(d(-1), PX, at(1));
        assert_eq!(u.qty(), d(0));
    }

    #[test]
    fn a_pnl_move_with_no_fill_seen_is_forgotten_after_a_while() {
        let mut u = Unshown::default();
        u.shown(d(-1), at(0), Read::Update);
        u.filled(d(-1), PX, at(31));
        assert_eq!(u.qty(), d(-1));
    }

    #[test]
    fn a_snapshot_absorbs_the_fills_it_shows_and_is_owed_no_later_fill() {
        let mut u = Unshown::default();
        u.filled(d(-1), PX, at(0));
        u.shown(d(-1), at(1), Read::Snapshot);
        assert_eq!(u.qty(), d(0));
        u.shown(d(2), at(2), Read::Snapshot);
        u.filled(d(1), PX, at(3));
        assert_eq!(
            u.qty(),
            d(1),
            "an overnight position read at connect swallows no buy"
        );
    }

    #[test]
    fn fills_are_shown_in_parts_or_together() {
        let mut u = Unshown::default();
        u.filled(d(2), PX, at(0));
        u.shown(d(1), at(0), Read::Update);
        assert_eq!(u.qty(), d(1));
        u.filled(d(1), PX, at(0));
        u.shown(d(2), at(0), Read::Update);
        assert_eq!(u.qty(), d(0));
    }
}
