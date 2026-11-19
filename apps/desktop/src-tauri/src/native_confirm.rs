//! Native confirm scaffolding — P0-2A / A-RFD.
//!
//! Lands `rfd =0.17.2` (`default-features = false`, `xdg-portal`) so
//! message-level auth (A-MLA) can show an OS dialog without pulling
//! gtk3. This module only keeps the crate linked; dialogs that mint
//! `SendGrant` must never return confirmation through IPC (R-3 / R-4).

use rfd::MessageLevel;

/// Expose the Info level so the `rfd` crate stays linked on every
/// target. Real confirm flows land in A-MLA.
pub fn info_level() -> MessageLevel {
    MessageLevel::Info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfd_message_level_is_linked() {
        let _ = info_level();
    }
}
