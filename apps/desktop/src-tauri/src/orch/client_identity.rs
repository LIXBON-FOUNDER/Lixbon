//! Frontera de identidad de clientes: alta del Desktop local y resolución de credenciales.

use std::path::Path;

use serde_json::json;

use super::Core;
use super::fsio::{read_json, write_private_json};
use super::events::{Channel, MutationContext};
use crate::store::{
    AuthenticatedClient, ClientAuthentication, ClientClaims, ClientCredential, ClientPrincipal,
    ClientRegistration, ClientSurface, DeviceIdentity, Store,
};
use crate::secure_store::{SecretKey, SecretStore, SecretValue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CliClientInfo {
    pub installation_id: String,
    pub client_id: String,
}

impl Core {
    pub(super) fn authenticate_client(&self, secret: &str) -> Result<Option<AuthenticatedClient>, String> {
        match self.storage.with_store(|store| store.authenticate_client(secret)) {
            Some(Ok(client)) => Ok(client),
            Some(Err(error)) => Err(format!("No se pudo consultar la identidad del cliente: {error:?}")),
            None => Err("El almacén de identidades no está disponible".into()),
        }
    }

    pub(super) fn authenticate_client_status(&self, secret: &str) -> Result<ClientAuthentication, String> {
        self.retry_pending_agent_revocations()?;
        match self.storage.with_store(|store| store.authenticate_client_at(secret, super::state::now_ms() as i64)) {
            Some(Ok(client)) => Ok(client),
            Some(Err(error)) => Err(format!("No se pudo consultar la identidad del cliente: {error:?}")),
            None => Err("El almacén de identidades no está disponible".into()),
        }
    }

    pub(super) fn ensure_cli_identity_with(
        &self,
        installation_file: &Path,
        secrets: &dyn SecretStore,
    ) -> Result<CliClientInfo, String> {
        let installation_id = load_or_create_installation_id(installation_file)?;
        let now = super::state::now_ms() as i64;
        let result = self.storage.with_store(|store| {
            provision_cli_identity(store, secrets, &installation_id, now)
        });
        let client = match result {
            Some(Ok(client)) => client,
            Some(Err(error)) => return Err(error),
            None => return Err("El almacén de identidades no está disponible".into()),
        };
        Ok(CliClientInfo {
            installation_id,
            client_id: client.identity().client_id().to_string(),
        })
    }

    pub(super) fn revoke_stale_cli_and_agent_credentials(&self, active_client_id: &str) -> Result<(), String> {
        let now = super::state::now_ms() as i64;
        match self.storage.with_store(|store| {
            store.revoke_other_cli_person_credentials(active_client_id, now)?;
            store.revoke_all_agent_credentials(now)?;
            Ok::<(), crate::store::StoreError>(())
        }) {
            Some(Ok(())) => Ok(()),
            Some(Err(error)) => Err(format!("No se pudieron revocar credenciales anteriores: {error}")),
            None => Err("El almacén de identidades no está disponible".into()),
        }
    }

    /// Cada proceso Agent recibe un secreto efímero ligado a su tarea; solo se conserva su client_id.
    pub(super) fn register_agent_credential(&self, task_id: &str) -> Result<(String, String), String> {
        let secret = strong_random_token()?;
        let installation_id = format!("agent-{}", strong_random_token()?.chars().take(32).collect::<String>());
        let registration = ClientRegistration::new(
            ClientSurface::Cli,
            DeviceIdentity::new(installation_id, None).map_err(|error| format!("Identidad Agent inválida: {error:?}"))?,
        ).map_err(|error| format!("Identidad Agent inválida: {error:?}"))?;
        let credential = ClientCredential::new(ClientPrincipal::Agent(task_id.to_string()), secret.clone())
            .map_err(|error| format!("No se pudo crear credencial Agent: {error:?}"))?;
        let client = self.storage.with_store(|store| {
            store.register_client(&registration, &credential, super::state::now_ms() as i64)
        });
        let Some(client) = client else { return Err("El almacén de identidades no está disponible".into()) };
        let client = client.map_err(|error| format!("No se pudo registrar credencial Agent: {error:?}"))?;
        Ok((secret, client.identity().client_id().to_string()))
    }

    pub(super) fn issue_agent_credential(&self, task_id: &str) -> Result<String, String> {
        let (secret, client_id) = self.register_agent_credential(task_id)?;
        self.agent_clients.lock().unwrap_or_else(|error| error.into_inner())
            .entry(task_id.to_string()).or_default().push(client_id);
        Ok(secret)
    }

    pub(super) fn revoke_agent_credentials(&self, task_id: &str) {
        {
            let clients = self.agent_clients.lock().unwrap_or_else(|error| error.into_inner());
            let client_ids = clients.get(task_id).cloned().unwrap_or_default();
            let mut pending = self.agent_revocations_pending.lock().unwrap_or_else(|error| error.into_inner());
            pending.extend(client_ids);
        }
        if self.retry_pending_agent_revocations().is_err() {
            // No incluye ids ni secretos. El pending set conserva la referencia y el HTTP auth
            // reintentará antes de aceptar cualquier credencial mientras SQLite no responda.
            eprintln!("Lixbon no confirmó la revocación Agent; el token queda bloqueado y se reintentará antes de autenticar");
        }
    }

    fn retry_pending_agent_revocations(&self) -> Result<(), String> {
        let client_ids: Vec<String> = self.agent_revocations_pending
            .lock().unwrap_or_else(|error| error.into_inner())
            .iter().cloned().collect();
        if client_ids.is_empty() {
            return Ok(());
        }

        let mut first_error = None;
        for client_id in client_ids {
            match self.revoke_agent_client(&client_id) {
                Ok(()) => {
                    self.agent_revocations_pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&client_id);
                    self.agent_clients.lock().unwrap_or_else(|error| error.into_inner()).retain(|_, ids| {
                        ids.retain(|active| active != &client_id);
                        !ids.is_empty()
                    });
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn revoke_agent_client(&self, client_id: &str) -> Result<(), String> {
        match self.storage.with_store(|store| store.revoke_client(client_id, super::state::now_ms() as i64)) {
            Some(Ok(_)) => Ok(()),
            Some(Err(error)) => Err(format!("No se pudo revocar la credencial Agent: {error}")),
            None => Err("El almacén de identidades no está disponible".into()),
        }
    }

    pub(super) fn desktop_client(&self) -> Result<Option<AuthenticatedClient>, String> {
        let mut cached = self.desktop_identity.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(client) = cached.as_ref() {
            return Ok(Some(client.clone()));
        }

        let credential = ClientCredential::new(ClientPrincipal::Person("user".into()), super::random_token())
            .map_err(|error| format!("No se pudo crear la identidad local de Desktop: {error:?}"))?;
        let registration = ClientRegistration::new(
            ClientSurface::Desktop,
            DeviceIdentity::new("desktop-local", None).map_err(|error| format!("Identidad local inválida: {error:?}"))?,
        )
        .map_err(|error| format!("Identidad local inválida: {error:?}"))?;
        let registered = self.storage.with_store(|store| {
            store.register_client(&registration, &credential, super::state::now_ms() as i64)
        });
        let Some(registered) = registered else {
            return Ok(None);
        };
        let client = registered.map_err(|error| format!("No se pudo registrar la identidad local de Desktop: {error:?}"))?;
        *cached = Some(client.clone());
        Ok(Some(client))
    }

    pub(super) fn desktop_mutation_context(&self) -> Result<MutationContext, String> {
        match self.desktop_client()? {
            Some(client) => MutationContext::authenticated(&client, &ClientClaims::default(), Channel::Ui)
                .map_err(|error| format!("Identidad de cliente inválida: {error:?}")),
            None => Ok(MutationContext::person(Channel::Ui)),
        }
    }
}

fn load_or_create_installation_id(path: &Path) -> Result<String, String> {
    if path.exists() {
        let value: serde_json::Value = read_json(path).ok_or("No se pudo leer la identidad CLI local".to_string())?;
        let id = value.get("installation_id").and_then(serde_json::Value::as_str)
            .filter(|id| is_installation_id(id)).ok_or("La identidad CLI local está dañada; respáldala y rótala manualmente".to_string())?;
        return Ok(id.to_string());
    }
    let id = format!("cli-{}", strong_random_token()?.chars().take(32).collect::<String>());
    write_private_json(path, &json!({ "installation_id": id }))?;
    Ok(id)
}

fn is_installation_id(value: &str) -> bool {
    value.starts_with("cli-") && value.len() == 36 && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn strong_random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "No se pudo obtener aleatoriedad segura del sistema".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn cli_secret_key(installation_id: &str) -> Result<SecretKey, String> {
    SecretKey::lixbon(&format!("client/cli/{installation_id}")).map_err(|error| format!("Clave CLI inválida: {error}"))
}

fn validate_cli_client(client: &AuthenticatedClient, installation_id: &str) -> Result<(), String> {
    let identity = client.identity();
    if identity.surface() != ClientSurface::Cli
        || identity.principal() != &ClientPrincipal::Person("user".into())
        || identity.device().map(DeviceIdentity::installation_id) != Some(installation_id)
    {
        return Err("La credencial segura CLI pertenece a otra identidad; rótala manualmente".into());
    }
    Ok(())
}

fn provision_cli_identity(
    store: &mut Store,
    secrets: &dyn SecretStore,
    installation_id: &str,
    now: i64,
) -> Result<AuthenticatedClient, String> {
    let key = cli_secret_key(installation_id)?;
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        DeviceIdentity::new(installation_id.to_string(), None).map_err(|error| format!("Identidad CLI inválida: {error:?}"))?,
    ).map_err(|error| format!("Identidad CLI inválida: {error:?}"))?;
    let principal = ClientPrincipal::Person("user".into());

    match secrets.get(&key) {
        Ok(secret) => match store.authenticate_client_at(secret.expose(), now).map_err(|error| format!("No se pudo validar la credencial CLI: {error}"))? {
            ClientAuthentication::Active(client) => {
                validate_cli_client(&client, installation_id)?;
                Ok(client)
            }
            ClientAuthentication::Expired(previous) => {
                validate_cli_client(&previous, installation_id)?;
                create_cli_credential(store, secrets, &key, &registration, principal, now)
            }
            ClientAuthentication::Revoked(_) => Err("La credencial CLI está revocada; elimina la instalación o crea una nueva desde Lixbon".into()),
            ClientAuthentication::Invalid => Err("La credencial CLI del almacén seguro no corresponde al Core; rótala manualmente".into()),
        },
        Err(error) if error.is_not_found() => create_cli_credential(store, secrets, &key, &registration, principal, now),
        Err(error) => Err(format!("El almacén seguro CLI no está disponible: {error}")),
    }
}

fn create_cli_credential(
    store: &mut Store,
    secrets: &dyn SecretStore,
    key: &SecretKey,
    registration: &ClientRegistration,
    principal: ClientPrincipal,
    now: i64,
) -> Result<AuthenticatedClient, String> {
    let token = strong_random_token()?;
    let credential = ClientCredential::new(principal, token.clone()).map_err(|error| format!("No se pudo crear credencial CLI: {error:?}"))?;
    let client = store.register_client(registration, &credential, now).map_err(|error| format!("No se pudo registrar credencial CLI: {error:?}"))?;
    let value = SecretValue::new(token).map_err(|error| format!("No se pudo preparar credencial CLI: {error}"))?;
    if let Err(error) = secrets.set(key, &value) {
        let _ = store.revoke_credential(client.credential_id(), now);
        return Err(format!("No se pudo guardar credencial CLI en el almacén seguro: {error}"));
    }
    if let Err(error) = store.revoke_client_credentials_except(client.identity().client_id(), client.credential_id(), now) {
        let _ = secrets.delete(key);
        let _ = store.revoke_credential(client.credential_id(), now);
        return Err(format!("No se pudo completar la rotación CLI: {error}"));
    }
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::{MemoryStore, SecretStore};
    use crate::store::{embedded, ClientAuthentication, CLIENT_CREDENTIAL_TTL_MS};

    fn store_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("lixbon-cli-identity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn cli_reconnecta_con_client_id_estable_y_secreto_exclusivamente_en_store() {
        let dir = store_dir("reconnect");
        let mut db = Store::open_with(&dir, &embedded(), "test").unwrap();
        let secrets = MemoryStore::new();
        let installation = "cli-0123456789abcdef0123456789abcdef";

        let first = provision_cli_identity(&mut db, &secrets, installation, 100).unwrap();
        let key = cli_secret_key(installation).unwrap();
        let first_secret = secrets.get(&key).unwrap();
        let second = provision_cli_identity(&mut db, &secrets, installation, 101).unwrap();
        let second_secret = secrets.get(&key).unwrap();

        assert_eq!(first.identity().client_id(), second.identity().client_id());
        assert_eq!(first.credential_id(), second.credential_id());
        assert_eq!(first_secret.expose(), second_secret.expose());
        assert_eq!(second.identity().surface(), ClientSurface::Cli);
        assert_eq!(second.identity().principal(), &ClientPrincipal::Person("user".into()));
        assert_eq!(second.identity().device().unwrap().installation_id(), installation);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cli_credencial_vencida_se_rota_y_la_anterior_queda_revocada() {
        let dir = store_dir("rotate");
        let mut db = Store::open_with(&dir, &embedded(), "test").unwrap();
        let secrets = MemoryStore::new();
        let installation = "cli-fedcba9876543210fedcba9876543210";
        let first = provision_cli_identity(&mut db, &secrets, installation, 100).unwrap();
        let key = cli_secret_key(installation).unwrap();
        let old_secret = secrets.get(&key).unwrap().expose().to_string();

        let second = provision_cli_identity(&mut db, &secrets, installation, 100 + CLIENT_CREDENTIAL_TTL_MS).unwrap();
        let new_secret = secrets.get(&key).unwrap().expose().to_string();

        assert_eq!(first.identity().client_id(), second.identity().client_id());
        assert_ne!(first.credential_id(), second.credential_id());
        assert_ne!(old_secret, new_secret);
        assert!(matches!(
            db.authenticate_client_at(&old_secret, 100 + CLIENT_CREDENTIAL_TTL_MS).unwrap(),
            ClientAuthentication::Revoked(_)
        ));
        assert!(matches!(
            db.authenticate_client_at(&new_secret, 101 + CLIENT_CREDENTIAL_TTL_MS).unwrap(),
            ClientAuthentication::Active(_)
        ));
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn credencial_cli_revocada_no_se_auto_reinscribe() {
        let dir = store_dir("revoked");
        let mut db = Store::open_with(&dir, &embedded(), "test").unwrap();
        let secrets = MemoryStore::new();
        let installation = "cli-00112233445566778899aabbccddeeff";
        let first = provision_cli_identity(&mut db, &secrets, installation, 100).unwrap();
        db.revoke_client(first.identity().client_id(), 101).unwrap();
        let before = secrets.get(&cli_secret_key(installation).unwrap()).unwrap().expose().to_string();

        let error = provision_cli_identity(&mut db, &secrets, installation, 102).unwrap_err();
        let after = secrets.get(&cli_secret_key(installation).unwrap()).unwrap();
        assert!(error.contains("revocada"));
        assert_eq!(before, after.expose());
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn identidad_installation_persistida_no_contiene_secreto() {
        let dir = store_dir("metadata");
        let path = dir.join("cli-client.json");
        let id = load_or_create_installation_id(&path).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(load_or_create_installation_id(&path).unwrap(), id);
        assert!(contents.contains("installation_id"));
        assert!(!contents.contains("token"));
        assert!(!contents.contains(&strong_random_token().unwrap()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn una_falla_transitoria_de_revocacion_agent_falla_cerrado_y_reintenta() {
        let (_cleanup, data, core_dir) = crate::orch::boot_tests::dirs();
        let (core, _host, started) = crate::orch::boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let task_id = "task-revoke-retry";
        let token = core.issue_agent_credential(task_id).unwrap();
        let client_id = core.agent_clients.lock().unwrap().get(task_id).unwrap()[0].clone();

        core.storage
            .with_store(|store| {
                store.write(|tx| {
                    tx.execute_batch(
                        "CREATE TRIGGER fail_agent_revoke BEFORE UPDATE ON clients \
                         BEGIN SELECT RAISE(ABORT, 'temporary revoke failure'); END;",
                    )?;
                    Ok(())
                })
            })
            .unwrap()
            .unwrap();

        core.revoke_agent_credentials(task_id);
        assert!(
            core.authenticate_client_status(&token).is_err(),
            "si Store no puede confirmar la revocación, el token debe quedar bloqueado y el Core responder no disponible"
        );
        assert!(core.agent_revocations_pending.lock().unwrap().contains(&client_id));
        assert!(core.agent_clients.lock().unwrap().get(task_id).is_some_and(|ids| ids.contains(&client_id)));

        core.storage
            .with_store(|store| {
                store.write(|tx| {
                    tx.execute_batch("DROP TRIGGER fail_agent_revoke")?;
                    Ok(())
                })
            })
            .unwrap()
            .unwrap();
        assert!(matches!(
            core.authenticate_client_status(&token).unwrap(),
            ClientAuthentication::Revoked(_)
        ), "el siguiente intento debe reintentar la revocación pendiente antes de autenticar");
        assert!(!core.agent_revocations_pending.lock().unwrap().contains(&client_id));
        assert!(core.agent_clients.lock().unwrap().get(task_id).is_none());
    }
}
