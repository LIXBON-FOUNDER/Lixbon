//! Frontera de identidad de clientes: alta del Desktop local y resolución de credenciales.

use super::Core;
use super::events::{Channel, MutationContext};
use crate::store::{
    AuthenticatedClient, ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration,
    ClientSurface, DeviceIdentity,
};

impl Core {
    pub(super) fn authenticate_client(&self, secret: &str) -> Result<Option<AuthenticatedClient>, String> {
        match self.storage.with_store(|store| store.authenticate_client(secret)) {
            Some(Ok(client)) => Ok(client),
            Some(Err(error)) => Err(format!("No se pudo consultar la identidad del cliente: {error:?}")),
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
