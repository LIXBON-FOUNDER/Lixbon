//! Identidad durable del cliente y credenciales autenticadas.
//!
//! `client_id` identifica una instalación/superficie; el actor y su scope vienen de la
//! credencial asociada, no del cuerpo de una petición. Solo se almacena SHA-256 del token;
//! el secreto nunca forma parte de `ClientIdentity`, Events ni el journal.

use std::fmt;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::secure_store::SecretValue;

use super::{new_uuid_v7, sha256_hex, Store, StoreError, StoreResult};

pub const CORE_CLIENT_ID: &str = "core-system";
const MIN_CLIENT_SECRET_BYTES: usize = 32;
/// Una credencial local se renueva tras 90 días, aunque el SO siga conservándola.
pub const CLIENT_CREDENTIAL_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ClientPrincipal {
    Person(String),
    Agent(String),
    System,
}

impl ClientPrincipal {
    fn validated(&self) -> Result<(), ClientIdentityError> {
        match self {
            ClientPrincipal::Person(id) | ClientPrincipal::Agent(id) => validate_identifier(id),
            ClientPrincipal::System => Err(ClientIdentityError::ReservedPrincipal),
        }
    }

    fn db_parts(&self) -> (&'static str, Option<&str>) {
        match self {
            ClientPrincipal::Person(id) => ("person", Some(id)),
            ClientPrincipal::Agent(id) => ("agent", Some(id)),
            ClientPrincipal::System => ("system", None),
        }
    }

    fn from_db(kind: &str, id: &str) -> StoreResult<ClientPrincipal> {
        let value = match kind {
            "person" => ClientPrincipal::Person(id.to_string()),
            "agent" => ClientPrincipal::Agent(id.to_string()),
            _ => {
                return Err(StoreError::InvalidDocument(
                    "tipo de actor inválido en client_credentials".into(),
                ))
            }
        };
        value.validated().map_err(|_| {
            StoreError::InvalidDocument("actor inválido en client_credentials".into())
        })?;
        Ok(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientSurface {
    Desktop,
    Cli,
    Mobile,
    Automation,
    Core,
}

impl ClientSurface {
    fn as_str(self) -> &'static str {
        match self {
            ClientSurface::Desktop => "desktop",
            ClientSurface::Cli => "cli",
            ClientSurface::Mobile => "mobile",
            ClientSurface::Automation => "automation",
            ClientSurface::Core => "core",
        }
    }

    fn from_db(value: &str) -> StoreResult<ClientSurface> {
        match value {
            "desktop" => Ok(ClientSurface::Desktop),
            "cli" => Ok(ClientSurface::Cli),
            "mobile" => Ok(ClientSurface::Mobile),
            "automation" => Ok(ClientSurface::Automation),
            "core" => Ok(ClientSurface::Core),
            _ => Err(StoreError::InvalidDocument(
                "surface inválida en clients".into(),
            )),
        }
    }

    fn transport_channel(self) -> &'static str {
        match self {
            ClientSurface::Desktop => "ui",
            ClientSurface::Cli => "lxo",
            ClientSurface::Mobile => "mobile",
            ClientSurface::Automation => "automation",
            ClientSurface::Core => "core",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceIdentity {
    installation_id: String,
    device_id: Option<String>,
}

impl DeviceIdentity {
    pub fn new(
        installation_id: impl Into<String>,
        device_id: Option<String>,
    ) -> Result<Self, ClientIdentityError> {
        let installation_id = installation_id.into();
        validate_identifier(&installation_id)?;
        if let Some(device_id) = &device_id {
            validate_identifier(device_id)?;
        }
        Ok(DeviceIdentity {
            installation_id,
            device_id,
        })
    }

    pub fn installation_id(&self) -> &str {
        &self.installation_id
    }

    pub fn device_id(&self) -> Option<&str> {
        self.device_id.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientRegistration {
    surface: ClientSurface,
    device: DeviceIdentity,
}

impl ClientRegistration {
    pub fn new(
        surface: ClientSurface,
        device: DeviceIdentity,
    ) -> Result<Self, ClientIdentityError> {
        if surface == ClientSurface::Core {
            return Err(ClientIdentityError::ReservedPrincipal);
        }
        Ok(ClientRegistration { surface, device })
    }
}

/// Actor, surface y dispositivo quedan juntos en la identidad resuelta, pero el `client_id`
/// permanece vinculado a la instalación y puede tener credenciales distintas por actor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientIdentity {
    client_id: String,
    principal: ClientPrincipal,
    surface: ClientSurface,
    device: Option<DeviceIdentity>,
    created_at: i64,
}

impl ClientIdentity {
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn principal(&self) -> &ClientPrincipal {
        &self.principal
    }

    pub fn surface(&self) -> ClientSurface {
        self.surface
    }

    pub fn device(&self) -> Option<&DeviceIdentity> {
        self.device.as_ref()
    }

    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    pub fn scope(&self) -> ClientScope {
        match &self.principal {
            ClientPrincipal::Person(id) => ClientScope::Person(id.clone()),
            ClientPrincipal::Agent(task) => ClientScope::AgentTask(task.clone()),
            ClientPrincipal::System => ClientScope::System,
        }
    }

    /// Identidad fija del propio Core. No se registra ni recibe credencial externa.
    pub fn core_system() -> ClientIdentity {
        ClientIdentity {
            client_id: CORE_CLIENT_ID.to_string(),
            principal: ClientPrincipal::System,
            surface: ClientSurface::Core,
            device: None,
            created_at: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ClientScope {
    Person(String),
    AgentTask(String),
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAction {
    /// Comando sin clasificación explícita: ninguna credencial externa lo autoriza.
    Unknown,
    Read,
    EventLogRead,
    AgentCommand,
    /// Operación de coordinación con comprobaciones de relación de tarea. Agent permanece
    /// limitado a su task; Person puede usarla como coordinador desde Desktop o CLI.
    AgentOrDesktopCommand,
    UiCommand,
    HumanDecision,
    CoreCommand,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientClaims {
    pub client_id: Option<String>,
    /// Campo legacy de `lxo`; si aparece, debe coincidir con el Agent autenticado.
    pub caller: Option<String>,
    pub principal: Option<ClientPrincipal>,
    pub surface: Option<ClientSurface>,
    pub scope: Option<ClientScope>,
    pub channel: Option<String>,
}

/// El secreto solo existe en memoria durante su alta/entrega. El almacén conserva su hash.
pub struct ClientCredential {
    credential_id: String,
    principal: ClientPrincipal,
    secret: SecretValue,
}

impl ClientCredential {
    pub fn new(
        principal: ClientPrincipal,
        secret: impl Into<String>,
    ) -> Result<Self, ClientIdentityError> {
        principal.validated()?;
        let secret =
            SecretValue::new(secret).map_err(|_| ClientIdentityError::InvalidCredential)?;
        if secret.len() < MIN_CLIENT_SECRET_BYTES {
            return Err(ClientIdentityError::InvalidCredential);
        }
        Ok(ClientCredential {
            credential_id: new_uuid_v7(),
            principal,
            secret,
        })
    }

    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    pub fn principal(&self) -> &ClientPrincipal {
        &self.principal
    }

    /// Úsalo solo para devolver el secreto en el alta explícita; nunca lo registres.
    pub fn reveal_for_delivery(&self) -> &str {
        self.secret.expose()
    }
}

impl fmt::Debug for ClientCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientCredential")
            .field("credential_id", &self.credential_id)
            .field("principal", &self.principal)
            .field("secret", &"<redactado>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedClient {
    credential_id: String,
    identity: ClientIdentity,
}

impl AuthenticatedClient {
    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    pub fn identity(&self) -> &ClientIdentity {
        &self.identity
    }

    pub fn scope(&self) -> ClientScope {
        self.identity.scope()
    }

    /// Los claims opcionales del cuerpo solo se aceptan si coinciden con la identidad ya
    /// resuelta por la credencial. El canal lo fija el transporte, no el cuerpo.
    pub fn validate_claims(
        &self,
        claims: &ClientClaims,
        transport_channel: &str,
    ) -> Result<(), ClientIdentityError> {
        if transport_channel != self.identity.surface.transport_channel() {
            return Err(ClientIdentityError::SurfaceChannelMismatch);
        }
        if claims
            .channel
            .as_deref()
            .is_some_and(|v| v != transport_channel)
        {
            return Err(ClientIdentityError::SpoofedChannel);
        }
        if claims
            .client_id
            .as_deref()
            .is_some_and(|v| v != self.identity.client_id)
        {
            return Err(ClientIdentityError::SpoofedClientId);
        }
        if claims
            .principal
            .as_ref()
            .is_some_and(|v| v != &self.identity.principal)
        {
            return Err(ClientIdentityError::SpoofedActor);
        }
        if claims.caller.as_deref().is_some_and(|caller| {
            !matches!(self.identity.principal(), ClientPrincipal::Agent(task) if caller == task)
        }) {
            return Err(ClientIdentityError::SpoofedActor);
        }
        if claims.surface.is_some_and(|v| v != self.identity.surface) {
            return Err(ClientIdentityError::SpoofedSurface);
        }
        if claims.scope.as_ref().is_some_and(|v| v != &self.scope()) {
            return Err(ClientIdentityError::SpoofedScope);
        }
        Ok(())
    }

    /// Scope viene de la credencial: un Agent nunca adquiere acciones humanas ni de Core.
    pub fn authorize(&self, action: ClientAction) -> Result<(), ClientIdentityError> {
        let allowed = match self.scope() {
            ClientScope::Person(_) => match action {
                ClientAction::CoreCommand | ClientAction::Unknown => false,
                ClientAction::EventLogRead | ClientAction::AgentOrDesktopCommand => {
                    matches!(self.identity.surface(), ClientSurface::Desktop | ClientSurface::Cli)
                }
                ClientAction::UiCommand | ClientAction::HumanDecision => {
                    self.identity.surface() == ClientSurface::Desktop
                }
                _ => true,
            },
            ClientScope::AgentTask(_) => {
                matches!(
                    action,
                    ClientAction::Read
                        | ClientAction::EventLogRead
                        | ClientAction::AgentCommand
                        | ClientAction::AgentOrDesktopCommand
                )
            }
            ClientScope::System => matches!(action, ClientAction::Read | ClientAction::CoreCommand),
        };
        if allowed {
            Ok(())
        } else {
            Err(ClientIdentityError::ForbiddenAction)
        }
    }
}

/// Resultado de autenticación necesario para distinguir token desconocido, vencido y revocado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientAuthentication {
    Active(AuthenticatedClient),
    Invalid,
    Expired(AuthenticatedClient),
    Revoked(AuthenticatedClient),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientIdentityError {
    InvalidIdentifier,
    InvalidCredential,
    ReservedPrincipal,
    RevokedClient,
    SpoofedActor,
    SpoofedClientId,
    SpoofedSurface,
    SpoofedScope,
    SpoofedChannel,
    SurfaceChannelMismatch,
    ForbiddenAction,
}

impl fmt::Display for ClientIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ClientIdentityError::InvalidIdentifier => "identificador de cliente inválido",
            ClientIdentityError::InvalidCredential => "credencial inválida",
            ClientIdentityError::ReservedPrincipal => {
                "la identidad System/Core está reservada al Core"
            }
            ClientIdentityError::RevokedClient => "la identidad del cliente está revocada",
            ClientIdentityError::SpoofedActor => {
                "el actor declarado no coincide con la credencial autenticada"
            }
            ClientIdentityError::SpoofedClientId => {
                "el client_id declarado no coincide con la credencial autenticada"
            }
            ClientIdentityError::SpoofedSurface => {
                "la surface declarada no coincide con la credencial autenticada"
            }
            ClientIdentityError::SpoofedScope => {
                "el scope declarado no coincide con la credencial autenticada"
            }
            ClientIdentityError::SpoofedChannel => {
                "el canal declarado no coincide con el transporte"
            }
            ClientIdentityError::SurfaceChannelMismatch => {
                "la credencial no corresponde al canal de transporte"
            }
            ClientIdentityError::ForbiddenAction => "la credencial no tiene scope para esta acción",
        })
    }
}

impl std::error::Error for ClientIdentityError {}

#[derive(Debug)]
pub enum ClientStoreError {
    Identity(ClientIdentityError),
    Store(StoreError),
}

impl fmt::Display for ClientStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientStoreError::Identity(e) => e.fmt(f),
            ClientStoreError::Store(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ClientStoreError {}

impl From<ClientIdentityError> for ClientStoreError {
    fn from(value: ClientIdentityError) -> Self {
        ClientStoreError::Identity(value)
    }
}

impl From<StoreError> for ClientStoreError {
    fn from(value: StoreError) -> Self {
        ClientStoreError::Store(value)
    }
}

fn validate_identifier(value: &str) -> Result<(), ClientIdentityError> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > 200
        || value.chars().any(char::is_control)
    {
        Err(ClientIdentityError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

impl Store {
    /// Registra o recupera el `client_id` estable para surface + installation_id y liga una
    /// credencial a un principal. El token se guarda únicamente como SHA-256.
    pub fn register_client(
        &mut self,
        registration: &ClientRegistration,
        credential: &ClientCredential,
        at: i64,
    ) -> Result<AuthenticatedClient, ClientStoreError> {
        if registration.surface == ClientSurface::Core {
            return Err(ClientIdentityError::ReservedPrincipal.into());
        }
        credential.principal.validated()?;
        let token_hash = sha256_hex(credential.secret.expose().as_bytes());
        let identity = self.write(|tx| {
            let existing: Option<(String, Option<String>, Option<i64>, i64)> = tx
                .query_row(
                    "SELECT client_id, device_id, revoked_at, created_at FROM clients WHERE surface = ?1 AND installation_id = ?2",
                    rusqlite::params![registration.surface.as_str(), registration.device.installation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;

            let (client_id, created_at) = match existing {
                Some((_, device_id, Some(_), _)) => {
                    let _ = device_id;
                    return Err(StoreError::InvalidDocument("la identidad del cliente está revocada".into()));
                }
                Some((id, device_id, None, created_at)) => {
                    if device_id != registration.device.device_id {
                        return Err(StoreError::InvalidDocument("la instalación ya existe con otra identidad de dispositivo".into()));
                    }
                    (id, created_at)
                }
                None => {
                    let id = new_uuid_v7();
                    tx.execute(
                        "INSERT INTO clients (client_id, surface, installation_id, device_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![id, registration.surface.as_str(), registration.device.installation_id, registration.device.device_id, at],
                    )?;
                    (id, at)
                }
            };

            let (principal_kind, principal_id) = credential.principal.db_parts();
            tx.execute(
                "INSERT INTO client_credentials (credential_id, client_id, principal_kind, principal_id, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![credential.credential_id, client_id, principal_kind, principal_id, token_hash, at],
            )?;

            Ok(ClientIdentity {
                client_id,
                principal: credential.principal.clone(),
                surface: registration.surface,
                device: Some(registration.device.clone()),
                created_at,
            })
        })?;
        Ok(AuthenticatedClient {
            credential_id: credential.credential_id.clone(),
            identity,
        })
    }

    /// Resuelve solo credenciales activas y devuelve identidad sin exponer ni retener el secreto.
    pub fn authenticate_client(&self, secret: &str) -> StoreResult<Option<AuthenticatedClient>> {
        match self.authenticate_client_inner(secret, None)? {
            ClientAuthentication::Active(client) => Ok(Some(client)),
            ClientAuthentication::Invalid
            | ClientAuthentication::Expired(_)
            | ClientAuthentication::Revoked(_) => Ok(None),
        }
    }

    /// Como [`Store::authenticate_client`], pero informa la causa de rechazo y hace cumplir el TTL.
    pub fn authenticate_client_at(&self, secret: &str, now: i64) -> StoreResult<ClientAuthentication> {
        self.authenticate_client_inner(secret, Some(now))
    }

    fn authenticate_client_inner(&self, secret: &str, now: Option<i64>) -> StoreResult<ClientAuthentication> {
        if secret.is_empty() {
            return Ok(ClientAuthentication::Invalid);
        }
        let token_hash = sha256_hex(secret.as_bytes());
        let row: Option<(String, String, String, String, Option<String>, String, String, i64, Option<i64>, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT cred.credential_id, cli.client_id, cli.surface, cli.installation_id, cli.device_id, cred.principal_kind, cred.principal_id, cred.created_at, cred.revoked_at, cli.revoked_at \
                 FROM client_credentials AS cred JOIN clients AS cli ON cli.client_id = cred.client_id \
                 WHERE cred.token_hash = ?1",
                [&token_hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
            )
            .optional()?;
        let Some((
            credential_id,
            client_id,
            surface,
            installation_id,
            device_id,
            principal_kind,
            principal_id,
            created_at,
            credential_revoked_at,
            client_revoked_at,
        )) = row
        else {
            return Ok(ClientAuthentication::Invalid);
        };
        let principal = ClientPrincipal::from_db(&principal_kind, &principal_id)?;
        let identity = ClientIdentity {
            client_id,
            principal,
            surface: ClientSurface::from_db(&surface)?,
            device: Some(
                DeviceIdentity::new(installation_id, device_id).map_err(|_| {
                    StoreError::InvalidDocument("device inválido en clients".into())
                })?,
            ),
            created_at,
        };
        let authenticated = AuthenticatedClient {
            credential_id,
            identity,
        };
        if credential_revoked_at.is_some() || client_revoked_at.is_some() {
            return Ok(ClientAuthentication::Revoked(authenticated));
        }
        if now.is_some_and(|at| at.saturating_sub(created_at) >= CLIENT_CREDENTIAL_TTL_MS) {
            return Ok(ClientAuthentication::Expired(authenticated));
        }
        Ok(ClientAuthentication::Active(authenticated))
    }

    pub fn revoke_credential(&mut self, credential_id: &str, at: i64) -> StoreResult<bool> {
        self.write(|tx| {
            let changed = tx.execute(
                "UPDATE client_credentials SET revoked_at = ?1 WHERE credential_id = ?2 AND revoked_at IS NULL",
                rusqlite::params![at, credential_id],
            )?;
            Ok(changed == 1)
        })
    }

    pub fn revoke_client(&mut self, client_id: &str, at: i64) -> StoreResult<bool> {
        self.write(|tx| {
            let changed = tx.execute(
                "UPDATE clients SET revoked_at = ?1 WHERE client_id = ?2 AND revoked_at IS NULL",
                rusqlite::params![at, client_id],
            )?;
            if changed == 1 {
                tx.execute(
                    "UPDATE client_credentials SET revoked_at = ?1 WHERE client_id = ?2 AND revoked_at IS NULL",
                    rusqlite::params![at, client_id],
                )?;
            }
            Ok(changed == 1)
        })
    }

    /// Revoca todas las credenciales anteriores de una instalación al completar una rotación.
    pub fn revoke_client_credentials_except(&mut self, client_id: &str, keep_credential_id: &str, at: i64) -> StoreResult<usize> {
        self.write(|tx| Ok(tx.execute(
            "UPDATE client_credentials SET revoked_at = ?1 WHERE client_id = ?2 AND credential_id <> ?3 AND revoked_at IS NULL",
            rusqlite::params![at, client_id, keep_credential_id],
        )?))
    }

    /// Core mantiene una sola identidad Person CLI activa por base local. Si se elimina
    /// metadata para recuperar una credencial perdida o revocada, la nueva inscripción
    /// invalida cualquier bearer Person CLI previo.
    pub fn revoke_other_cli_person_credentials(&mut self, client_id: &str, at: i64) -> StoreResult<usize> {
        self.write(|tx| Ok(tx.execute(
            "UPDATE client_credentials SET revoked_at = ?1 \
             WHERE revoked_at IS NULL AND principal_kind = 'person' AND client_id <> ?2 \
             AND client_id IN (SELECT client_id FROM clients WHERE surface = 'cli')",
            rusqlite::params![at, client_id],
        )?))
    }

    /// El reinicio del Core no conserva procesos Agent vivos: sus credenciales anteriores se invalidan.
    pub fn revoke_all_agent_credentials(&mut self, at: i64) -> StoreResult<usize> {
        self.write(|tx| Ok(tx.execute(
            "UPDATE client_credentials SET revoked_at = ?1 WHERE principal_kind = 'agent' AND revoked_at IS NULL",
            [at],
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lixbon-client-registry-{}-{}",
            std::process::id(),
            new_uuid_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn registration(surface: ClientSurface, installation: &str) -> ClientRegistration {
        ClientRegistration::new(
            surface,
            DeviceIdentity::new(installation, Some("device-01".into())).unwrap(),
        )
        .unwrap()
    }

    fn token(label: &str) -> String {
        format!("{label}-{}", "x".repeat(MIN_CLIENT_SECRET_BYTES))
    }

    #[test]
    fn credential_rechaza_secretos_cortos() {
        assert_eq!(
            ClientCredential::new(ClientPrincipal::Person("person-1".into()), "short-token")
                .unwrap_err(),
            ClientIdentityError::InvalidCredential
        );
    }

    #[test]
    fn client_registry_schema_is_embedded_and_available() {
        let dir = dir();
        let store = Store::open(&dir, "test").unwrap();
        let clients: Option<String> = store
            .conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='clients'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        let credentials: Option<String> = store
            .conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='client_credentials'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(clients.as_deref(), Some("clients"));
        assert_eq!(credentials.as_deref(), Some("client_credentials"));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn client_id_permanece_estable_por_instalacion_y_scope_viene_de_credencial() {
        let dir = dir();
        let client = registration(ClientSurface::Cli, "install-a");
        let human =
            ClientCredential::new(ClientPrincipal::Person("person-1".into()), token("person"))
                .unwrap();
        let first_id;
        {
            let mut store = Store::open(&dir, "test").unwrap();
            let first = store.register_client(&client, &human, 100).unwrap();
            first_id = first.identity().client_id().to_string();
            assert_eq!(first.scope(), ClientScope::Person("person-1".into()));

            let agent =
                ClientCredential::new(ClientPrincipal::Agent("task-1".into()), token("agent"))
                    .unwrap();
            let second = store.register_client(&client, &agent, 101).unwrap();
            assert_eq!(second.identity().client_id(), first_id);
            assert_eq!(second.scope(), ClientScope::AgentTask("task-1".into()));
            assert_ne!(
                second.identity().client_id(),
                "task-1",
                "device client_id is distinct from actor id"
            );
        }

        let store = Store::open(&dir, "test").unwrap();
        let resumed = store.authenticate_client(&token("agent")).unwrap().unwrap();
        assert_eq!(resumed.identity().client_id(), first_id);
        assert_eq!(resumed.identity().surface(), ClientSurface::Cli);
        assert_eq!(
            resumed.identity().device().unwrap().installation_id(),
            "install-a"
        );
        assert_eq!(
            resumed.identity().principal(),
            &ClientPrincipal::Agent("task-1".into())
        );
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn claims_del_cuerpo_no_pueden_suplantar_actor_cliente_surface_scope_ni_canal() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let cred =
            ClientCredential::new(ClientPrincipal::Agent("task-1".into()), token("agent")).unwrap();
        let auth = store
            .register_client(&registration(ClientSurface::Cli, "install-b"), &cred, 100)
            .unwrap();

        let claims = ClientClaims {
            principal: Some(ClientPrincipal::Person("person-1".into())),
            ..Default::default()
        };
        assert_eq!(
            auth.validate_claims(&claims, "lxo"),
            Err(ClientIdentityError::SpoofedActor)
        );
        let claims = ClientClaims {
            client_id: Some("otro-cliente".into()),
            ..Default::default()
        };
        assert_eq!(
            auth.validate_claims(&claims, "lxo"),
            Err(ClientIdentityError::SpoofedClientId)
        );
        let claims = ClientClaims {
            surface: Some(ClientSurface::Desktop),
            ..Default::default()
        };
        assert_eq!(
            auth.validate_claims(&claims, "lxo"),
            Err(ClientIdentityError::SpoofedSurface)
        );
        let claims = ClientClaims {
            scope: Some(ClientScope::Person("person-1".into())),
            ..Default::default()
        };
        assert_eq!(
            auth.validate_claims(&claims, "lxo"),
            Err(ClientIdentityError::SpoofedScope)
        );
        let claims = ClientClaims {
            channel: Some("ui".into()),
            ..Default::default()
        };
        assert_eq!(
            auth.validate_claims(&claims, "lxo"),
            Err(ClientIdentityError::SpoofedChannel)
        );
        assert_eq!(
            auth.validate_claims(&ClientClaims::default(), "ui"),
            Err(ClientIdentityError::SurfaceChannelMismatch)
        );

        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn caller_legacy_del_cuerpo_no_puede_cambiar_el_agent_de_la_credencial() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let credential = ClientCredential::new(
            ClientPrincipal::Agent("task-authenticated".into()),
            token("caller-claim"),
        )
        .unwrap();
        let authenticated = store
            .register_client(
                &registration(ClientSurface::Cli, "install-caller-claim"),
                &credential,
                100,
            )
            .unwrap();

        let spoofed: ClientClaims = serde_json::from_value(serde_json::json!({
            "caller": "task-other"
        }))
        .unwrap();
        assert_eq!(
            authenticated.validate_claims(&spoofed, "lxo"),
            Err(ClientIdentityError::SpoofedActor)
        );

        let matching: ClientClaims = serde_json::from_value(serde_json::json!({
            "caller": "task-authenticated"
        }))
        .unwrap();
        assert_eq!(authenticated.validate_claims(&matching, "lxo"), Ok(()));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_no_puede_ejecutar_una_decision_humana_ni_una_accion_core() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let cred =
            ClientCredential::new(ClientPrincipal::Agent("task-1".into()), token("agent")).unwrap();
        let auth = store
            .register_client(&registration(ClientSurface::Cli, "install-c"), &cred, 100)
            .unwrap();
        assert!(auth.authorize(ClientAction::AgentCommand).is_ok());
        assert_eq!(
            auth.authorize(ClientAction::HumanDecision),
            Err(ClientIdentityError::ForbiddenAction)
        );
        assert_eq!(
            auth.authorize(ClientAction::CoreCommand),
            Err(ClientIdentityError::ForbiddenAction)
        );
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn comandos_de_coordinador_permiten_agent_persona_desktop_y_persona_cli() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let person_desktop = ClientCredential::new(
            ClientPrincipal::Person("person-desktop".into()),
            token("person-desktop"),
        )
        .unwrap();
        let person_cli = ClientCredential::new(
            ClientPrincipal::Person("person-cli".into()),
            token("person-cli"),
        )
        .unwrap();
        let agent = ClientCredential::new(
            ClientPrincipal::Agent("task-1".into()),
            token("agent-scoped"),
        )
        .unwrap();
        let desktop = store
            .register_client(
                &registration(ClientSurface::Desktop, "install-action-desktop"),
                &person_desktop,
                100,
            )
            .unwrap();
        let cli = store
            .register_client(
                &registration(ClientSurface::Cli, "install-action-cli"),
                &person_cli,
                101,
            )
            .unwrap();
        let worker = store
            .register_client(
                &registration(ClientSurface::Cli, "install-action-agent"),
                &agent,
                102,
            )
            .unwrap();

        assert!(desktop.authorize(ClientAction::AgentOrDesktopCommand).is_ok());
        assert!(cli.authorize(ClientAction::AgentOrDesktopCommand).is_ok());
        assert!(worker.authorize(ClientAction::AgentOrDesktopCommand).is_ok());
        assert_eq!(cli.authorize(ClientAction::UiCommand), Err(ClientIdentityError::ForbiddenAction));
        assert_eq!(cli.authorize(ClientAction::HumanDecision), Err(ClientIdentityError::ForbiddenAction));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn system_core_no_admite_credencial_externa() {
        assert_eq!(
            ClientCredential::new(ClientPrincipal::System, token("system")).unwrap_err(),
            ClientIdentityError::ReservedPrincipal
        );
        assert_eq!(ClientIdentity::core_system().client_id(), CORE_CLIENT_ID);
        assert_eq!(ClientIdentity::core_system().scope(), ClientScope::System);
        assert_eq!(
            ClientRegistration::new(
                ClientSurface::Core,
                DeviceIdentity::new("core", None).unwrap()
            )
            .unwrap_err(),
            ClientIdentityError::ReservedPrincipal
        );
    }

    #[test]
    fn el_secreto_no_se_persiste_ni_aparece_en_debug_o_identidad_serializada() {
        let dir = dir();
        let secret = token("SECRET-CLIENT-TOKEN-773");
        let mut store = Store::open(&dir, "test").unwrap();
        let cred =
            ClientCredential::new(ClientPrincipal::Person("person-1".into()), secret.clone())
                .unwrap();
        let auth = store
            .register_client(
                &registration(ClientSurface::Desktop, "install-d"),
                &cred,
                100,
            )
            .unwrap();

        let hash: String = store
            .conn
            .query_row(
                "SELECT token_hash FROM client_credentials WHERE credential_id = ?1",
                [cred.credential_id()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, secret);
        assert!(!format!("{cred:?}").contains(&secret));
        assert!(!serde_json::to_string(auth.identity())
            .unwrap()
            .contains(&secret));
        assert!(!format!("{auth:?}").contains(&secret));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn revocar_credencial_impide_reutilizarla_sin_borrar_identidad() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let secret = token("revoke-me");
        let cred =
            ClientCredential::new(ClientPrincipal::Person("person-1".into()), secret.clone())
                .unwrap();
        let auth = store
            .register_client(
                &registration(ClientSurface::Desktop, "install-e"),
                &cred,
                100,
            )
            .unwrap();
        assert!(store.revoke_credential(auth.credential_id(), 200).unwrap());
        assert!(store.authenticate_client(&secret).unwrap().is_none());
        assert!(!store.revoke_credential(auth.credential_id(), 201).unwrap());
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn autenticacion_distingue_credencial_invalida_vencida_y_revocada() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let secret = token("lifetime");
        let credential = ClientCredential::new(ClientPrincipal::Person("person-ttl".into()), secret.clone()).unwrap();
        let auth = store.register_client(&registration(ClientSurface::Cli, "install-ttl"), &credential, 10_000).unwrap();

        assert_eq!(store.authenticate_client_at("no-registrada", 10_001).unwrap(), ClientAuthentication::Invalid);
        assert!(matches!(
            store.authenticate_client_at(&secret, 10_000 + CLIENT_CREDENTIAL_TTL_MS).unwrap(),
            ClientAuthentication::Expired(_)
        ));
        store.revoke_credential(auth.credential_id(), 10_001).unwrap();
        assert!(matches!(
            store.authenticate_client_at(&secret, 10_002).unwrap(),
            ClientAuthentication::Revoked(_)
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn identidad_externa_no_autoriza_acciones_sin_clasificacion() {
        let dir = dir();
        let mut store = Store::open(&dir, "test").unwrap();
        let cred = ClientCredential::new(ClientPrincipal::Agent("task-unknown".into()), token("unknown-action")).unwrap();
        let auth = store.register_client(&registration(ClientSurface::Cli, "install-unknown"), &cred, 100).unwrap();
        assert_eq!(auth.authorize(ClientAction::Unknown), Err(ClientIdentityError::ForbiddenAction));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
