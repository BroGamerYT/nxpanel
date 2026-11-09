//! NexusCore Rust Core – Host-Abstraktionsschicht für Treiber & Server-Management.

pub mod server;
pub use server::ServerHandle;

/// Konfiguration für einen Gameserver-Prozess.
#[derive(Debug, Clone)]
pub struct ProcessConfig {
    pub executable: String,
    pub args: Vec<String>,
    pub working_dir: std::path::PathBuf,
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// Status eines Servers.
#[derive(Debug, Clone, Copy)]
pub enum ServerStatus {
    Offline,
    Starting,
    Running,
    Stopping,
    Error(String),
}

impl Default for ServerStatus {
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() {
    println!("NexusCore Rust Core – Host-Abstraktionsschicht");
    
    // Hier würde der eigentliche Server-Loop laufen.
    loop {
        sleep(Duration::from_secs(1)).await;
    }
}

    fn default() -> Self {
        Self::Offline
    }
}
