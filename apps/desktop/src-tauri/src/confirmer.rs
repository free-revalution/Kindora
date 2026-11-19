//! Native user confirmation for MLA — P0-2A / A-MLA (R-3 / R-4).
//!
//! Confirmation results stay in Rust; never return grant tokens via IPC.

use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfirmError {
    #[error("rate-limited")]
    RateLimited,
    #[error("dialog-failed")]
    DialogFailed,
}

/// User presence confirmation for outbound sends (MLA).
pub trait UserConfirmer: Send + Sync {
    fn confirm_send(&self, summary: &str) -> Result<bool, ConfirmError>;
}

/// Scriptable confirmer for unit tests — never used in production.
#[derive(Debug, Clone)]
pub struct MockConfirmer {
    pub always: bool,
}

impl UserConfirmer for MockConfirmer {
    fn confirm_send(&self, _summary: &str) -> Result<bool, ConfirmError> {
        Ok(self.always)
    }
}

const DIALOG_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// Production confirmer using `rfd` native message dialogs.
pub struct RfdConfirmer {
    last_dialog: Mutex<Option<Instant>>,
}

impl RfdConfirmer {
    pub fn new() -> Self {
        Self {
            last_dialog: Mutex::new(None),
        }
    }

    pub(crate) fn take_rate_limit_slot(&self) -> Result<(), ConfirmError> {
        let mut guard = self
            .last_dialog
            .lock()
            .map_err(|_| ConfirmError::DialogFailed)?;
        let now = Instant::now();
        if let Some(prev) = *guard {
            if now.duration_since(prev) < DIALOG_MIN_INTERVAL {
                return Err(ConfirmError::RateLimited);
            }
        }
        *guard = Some(now);
        Ok(())
    }
}

impl Default for RfdConfirmer {
    fn default() -> Self {
        Self::new()
    }
}

impl UserConfirmer for RfdConfirmer {
    fn confirm_send(&self, summary: &str) -> Result<bool, ConfirmError> {
        self.take_rate_limit_slot()?;
        let dialog = MessageDialog::new()
            .set_title("Kindora")
            .set_description(summary)
            .set_level(MessageLevel::Info)
            .set_buttons(MessageButtons::OkCancel);
        let choice = dialog.show();
        match choice {
            MessageDialogResult::Ok => Ok(true),
            MessageDialogResult::Cancel | MessageDialogResult::No => Ok(false),
            MessageDialogResult::Yes => Ok(true),
            MessageDialogResult::Custom(_) => {
                #[cfg(target_os = "linux")]
                {
                    Err(ConfirmError::DialogFailed)
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Ok(false)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_returns_configured_choice() {
        let yes = MockConfirmer { always: true };
        let no = MockConfirmer { always: false };
        assert!(yes.confirm_send("send?").unwrap());
        assert!(!no.confirm_send("send?").unwrap());
    }

    #[test]
    fn rfd_rate_limits_rapid_calls() {
        let c = RfdConfirmer::new();
        c.take_rate_limit_slot().unwrap();
        assert_eq!(c.take_rate_limit_slot(), Err(ConfirmError::RateLimited));
    }
}