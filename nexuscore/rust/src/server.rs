use crate::{ProcessConfig, ServerStatus};
use std::process::Command;

/// Handle für einen gestarteten Gameserver-Prozess.
pub struct ServerHandle {
    pub status: ServerStatus,
    pub process: Option<std::process::Child>,
}

impl Default for ServerHandle {
    fn default() -> Self {
        Self {
            status: ServerStatus::Offline,
            process: None,
        }
    }
}

impl ServerHandle {
    /// Startet einen Gameserver-Prozess.
    pub async fn start(&mut self, config: ProcessConfig) -> Result<(), Box<dyn std::error::Error>> {
        tracing::info!("Starte Server: {}", config.executable);

        let mut cmd = Command::new(&config.executable);
        cmd.args(config.args)
            .current_dir(&config.working_dir)
            .envs(config.env.unwrap_or_default());

        let child = cmd.spawn()?;

        self.process = Some(child);
        self.status = ServerStatus::Running;

        Ok(())
    }

    /// Stoppt den Server (Kill).
    pub async fn stop(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(mut child) = self.process.take() {
            tracing::info!("Stoppe Server...");
            child.kill()?;
            child.wait()?;
        }
        self.status = ServerStatus::Offline;
        Ok(())
    }

    /// Gibt den aktuellen Status zurück.
    pub fn status(&self) -> &ServerStatus {
        &self.status
    }
}
