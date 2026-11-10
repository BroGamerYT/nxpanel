use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct InfoResponse {
    pub name: &'static str,
    pub version: &'static str,
    pub runtime: &'static str,
    pub platform: &'static str,
    pub status: &'static str,
}

#[derive(Serialize)]
pub struct UserInfo {
    pub id: &'static str,
    pub username: &'static str,
    pub email: &'static str,
    pub role: &'static str,
    pub locale: &'static str,
}

#[derive(Serialize)]
pub struct Permissions {
    #[serde(rename = "admin.nodes")]
    pub admin_nodes: bool,
    #[serde(rename = "admin.users")]
    pub admin_users: bool,
    #[serde(rename = "admin.hosts")]
    pub admin_hosts: bool,
    #[serde(rename = "servers.create")]
    pub servers_create: bool,
}

#[derive(Serialize)]
pub struct AuthMeResponse {
    pub user: UserInfo,
    pub permissions: Permissions,
}

#[derive(Serialize)]
pub struct AboutResponse {
    pub name: &'static str,
    pub version: &'static str,
    pub build: &'static str,
}

#[derive(Serialize)]
pub struct ServerListResponse {
    pub servers: Vec<ServerItem>,
}

#[derive(Serialize)]
pub struct ServerItem {
    pub id: String,
    pub name: String,
    pub status: &'static str,
    pub game: String,
}

pub fn create_router() -> Router {
    Router::new()
        .route("/core/v1/info", get(handle_info))
        .route("/api/v1/about", get(handle_about))
        .route("/api/v1/auth/me", get(handle_auth_me))
        .route("/api/v1/auth/refresh", post(handle_auth_refresh))
        .route("/api/v1/servers", get(handle_servers))
}

async fn handle_info() -> Json<InfoResponse> {
    Json(InfoResponse {
        name: "nexuscore-rust",
        version: "0.1.0",
        runtime: "rust-native",
        platform: std::env::consts::OS,
        status: "online",
    })
}

async fn handle_about() -> Json<AboutResponse> {
    Json(AboutResponse {
        name: "NexusPanel Standalone (Rust Engine)",
        version: "0.1.0",
        build: "native-x86_64",
    })
}

async fn handle_auth_me() -> Json<AuthMeResponse> {
    Json(AuthMeResponse {
        user: UserInfo {
            id: "standalone-admin",
            username: "Admin",
            email: "admin@localhost",
            role: "admin",
            locale: "de",
        },
        permissions: Permissions {
            admin_nodes: true,
            admin_users: true,
            admin_hosts: true,
            servers_create: true,
        },
    })
}

#[derive(Serialize)]
pub struct RefreshResponse {
    pub access_token: &'static str,
}

async fn handle_auth_refresh() -> Json<RefreshResponse> {
    Json(RefreshResponse {
        access_token: "nexus-rust-standalone-token",
    })
}

async fn handle_servers() -> Json<ServerListResponse> {
    Json(ServerListResponse {
        servers: vec![],
    })
}
