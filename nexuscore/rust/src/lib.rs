//! NexusCore Rust Core – Host-Abstraktionsschicht für Treiber & Server-Management.

pub mod server;
pub mod http;
pub use server::ServerHandle;

/// Konfiguration für einen Gameserver-Prozess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessConfig {
    pub executable: String,
    pub args: Vec<String>,
    pub working_dir: std::path::PathBuf,
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// Status eines Servers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerStatus {
    Offline,
    Starting,
    Running,
    Stopping,
    Error(String),
}

impl Default for ServerStatus {
    fn default() -> Self {
        Self::Offline
    }
}
