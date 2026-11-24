//! In rithmic-rs 3.2 a dropped plant's actor keeps running, keeping the connection and login alive.
//! Rithmic answers sessions beyond its per-user limit with a ForcedLogout.

use rithmic_rs::{
    RithmicAccount, RithmicHistoryPlant, RithmicOrderPlant, RithmicPnlPlant, RithmicTickerPlant,
};

pub(crate) trait Stoppable {
    fn stop(&self);
}

impl Stoppable for RithmicTickerPlant {
    fn stop(&self) {
        self.get_handle().abort();
    }
}

impl Stoppable for RithmicHistoryPlant {
    fn stop(&self) {
        self.get_handle().abort();
    }
}

impl Stoppable for RithmicOrderPlant {
    fn stop(&self) {
        // The abort reaches the plant's one actor whichever account the handle is scoped to.
        self.get_handle(&RithmicAccount::new("", "", "")).abort();
    }
}

impl Stoppable for RithmicPnlPlant {
    fn stop(&self) {
        self.get_handle(&RithmicAccount::new("", "", "")).abort();
    }
}

pub(crate) struct Owned<P: Stoppable>(P);

impl<P: Stoppable> Owned<P> {
    pub(crate) fn new(plant: P) -> Self {
        Self(plant)
    }
}

impl<P: Stoppable> std::ops::Deref for Owned<P> {
    type Target = P;

    fn deref(&self) -> &P {
        &self.0
    }
}

impl<P: Stoppable> Drop for Owned<P> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

impl<P: Stoppable + std::fmt::Debug> std::fmt::Debug for Owned<P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Owned").field(&self.0).finish()
    }
}
