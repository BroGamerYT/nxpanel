//! NexusCore Rust Core – Binär-Einstiegspunkt.

use nexuscore::http::create_router;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let port = std::env::var("PORT").unwrap_or_else(|_| "8444".to_string());
    let addr = format!("0.0.0.0:{}", port);

    println!("⚡ NexusCore Rust Core v0.1.0 gestartet");
    println!("Web & API laeuft auf: http://{}", addr);

    let app = create_router();
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
