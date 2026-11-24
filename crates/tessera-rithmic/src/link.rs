use tessera_core::health::ConnectionPhase;

use crate::session::OpenError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    LoggedIn,
    Retrying { attempt: u32, reason: String },
    Waiting,
    LoggedOut,
    TakenOver,
    Refused(String),
    Unreachable(String),
}

impl Event {
    pub(crate) fn failed(e: &OpenError) -> Self {
        match e {
            OpenError::Refused(m) => Self::Refused(m.clone()),
            OpenError::Transport(m) => Self::Unreachable(m.clone()),
            OpenError::Gate(_) => Self::LoggedOut,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Link {
    generation: u64,
    phase: ConnectionPhase,
}

impl Default for Link {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: ConnectionPhase::Stopped,
        }
    }
}

fn running(phase: &ConnectionPhase) -> bool {
    *phase == ConnectionPhase::Live || phase.coming_back()
}

impl Link {
    pub(crate) fn phase(&self) -> &ConnectionPhase {
        &self.phase
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    pub(crate) fn running(&self, generation: u64) -> bool {
        self.current(generation) && running(&self.phase)
    }

    pub(crate) fn start(&mut self) -> u64 {
        self.generation += 1;
        self.phase = ConnectionPhase::Connecting;
        self.generation
    }

    pub(crate) fn stop(&mut self) {
        self.generation += 1;
        self.phase = ConnectionPhase::Stopped;
    }

    #[cfg(test)]
    pub(crate) fn assume(&mut self, phase: ConnectionPhase) -> u64 {
        self.generation += 1;
        self.phase = phase;
        self.generation
    }

    pub(crate) fn supersede(&mut self, generation: u64, event: Event) -> Option<u64> {
        if !self.running(generation) {
            return None;
        }
        self.generation += 1;
        self.phase = Self::after(event);
        Some(self.generation)
    }

    pub(crate) fn advance(&mut self, generation: u64, event: Event) -> bool {
        if !self.running(generation) {
            return false;
        }
        self.phase = Self::after(event);
        true
    }

    fn after(event: Event) -> ConnectionPhase {
        match event {
            Event::LoggedIn => ConnectionPhase::Live,
            Event::Retrying { attempt, reason } => {
                ConnectionPhase::Reconnecting { attempt, reason }
            }
            Event::Waiting => ConnectionPhase::Waiting,
            Event::LoggedOut => ConnectionPhase::LoggedOut,
            Event::TakenOver => ConnectionPhase::TakenOver,
            Event::Refused(reason) => ConnectionPhase::Refused { reason },
            Event::Unreachable(reason) => ConnectionPhase::Unreachable { reason },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retrying(attempt: u32) -> Event {
        Event::Retrying {
            attempt,
            reason: "heartbeat timeout".into(),
        }
    }

    fn reconnecting(attempt: u32) -> ConnectionPhase {
        ConnectionPhase::Reconnecting {
            attempt,
            reason: "heartbeat timeout".into(),
        }
    }

    fn at(phase: ConnectionPhase) -> (Link, u64) {
        let mut link = Link::default();
        let generation = link.start();
        link.phase = phase;
        (link, generation)
    }

    #[test]
    fn every_edge_of_one_generation() {
        let refused = || ConnectionPhase::Refused {
            reason: "no".into(),
        };
        let unreachable = || ConnectionPhase::Unreachable {
            reason: "down".into(),
        };
        let table: Vec<(ConnectionPhase, Event, Option<ConnectionPhase>)> = vec![
            (
                ConnectionPhase::Connecting,
                Event::LoggedIn,
                Some(ConnectionPhase::Live),
            ),
            (
                ConnectionPhase::Connecting,
                Event::Refused("no".into()),
                Some(refused()),
            ),
            (
                ConnectionPhase::Connecting,
                Event::Unreachable("down".into()),
                Some(unreachable()),
            ),
            (
                ConnectionPhase::Connecting,
                Event::LoggedOut,
                Some(ConnectionPhase::LoggedOut),
            ),
            (ConnectionPhase::Live, retrying(1), Some(reconnecting(1))),
            (
                ConnectionPhase::Live,
                Event::Waiting,
                Some(ConnectionPhase::Waiting),
            ),
            (reconnecting(1), retrying(2), Some(reconnecting(2))),
            (
                reconnecting(2),
                Event::LoggedIn,
                Some(ConnectionPhase::Live),
            ),
            (
                reconnecting(2),
                Event::Refused("no".into()),
                Some(refused()),
            ),
            (
                ConnectionPhase::Waiting,
                Event::LoggedIn,
                Some(ConnectionPhase::Live),
            ),
            (
                ConnectionPhase::Waiting,
                Event::TakenOver,
                Some(ConnectionPhase::TakenOver),
            ),
            (
                ConnectionPhase::Waiting,
                Event::LoggedOut,
                Some(ConnectionPhase::LoggedOut),
            ),
            (ConnectionPhase::Stopped, Event::LoggedIn, None),
            (ConnectionPhase::Stopped, retrying(1), None),
            (ConnectionPhase::TakenOver, Event::LoggedIn, None),
            (ConnectionPhase::TakenOver, retrying(1), None),
            (ConnectionPhase::LoggedOut, Event::LoggedIn, None),
            (refused(), retrying(1), None),
            (unreachable(), Event::LoggedIn, None),
        ];
        for (from, event, to) in table {
            let (mut link, generation) = at(from.clone());
            let moved = link.advance(generation, event.clone());
            assert_eq!(
                (moved, link.phase().clone()),
                (to.is_some(), to.unwrap_or_else(|| from.clone())),
                "{from:?} on {event:?}"
            );
        }
    }

    #[test]
    fn an_event_from_an_older_generation_changes_nothing() {
        let mut link = Link::default();
        let old = link.start();
        assert!(link.advance(old, Event::LoggedIn));
        let new = link.start();
        assert!(!link.advance(old, retrying(1)));
        assert!(!link.advance(old, Event::LoggedIn));
        assert_eq!(link.supersede(old, Event::TakenOver), None);
        assert_eq!(*link.phase(), ConnectionPhase::Connecting);
        assert!(link.advance(new, Event::LoggedIn));
        assert_eq!(*link.phase(), ConnectionPhase::Live);
    }

    #[test]
    fn stopped_holds_until_the_next_start() {
        let mut link = Link::default();
        let generation = link.start();
        assert!(link.advance(generation, Event::LoggedIn));
        link.stop();
        for event in [
            Event::LoggedIn,
            retrying(2),
            Event::Waiting,
            Event::TakenOver,
        ] {
            assert!(!link.advance(link.generation(), event));
        }
        assert_eq!(link.supersede(link.generation(), retrying(1)), None);
        assert_eq!(*link.phase(), ConnectionPhase::Stopped);
        let next = link.start();
        assert!(link.advance(next, Event::LoggedIn));
    }

    #[test]
    fn a_forced_logout_starts_a_new_generation_and_ends_the_old_one() {
        let mut link = Link::default();
        let first = link.start();
        assert!(link.advance(first, Event::LoggedIn));
        let again = link.supersede(first, retrying(1)).unwrap();
        assert_eq!(*link.phase(), reconnecting(1));
        assert_eq!(link.supersede(first, Event::TakenOver), None);
        assert!(!link.advance(first, Event::LoggedIn));
        assert!(link.advance(again, Event::LoggedIn));
        assert_eq!(
            link.supersede(again, Event::TakenOver)
                .map(|_| link.phase().clone()),
            Some(ConnectionPhase::TakenOver)
        );
    }
}
